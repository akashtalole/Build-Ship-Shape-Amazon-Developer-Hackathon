import { randomUUID } from "node:crypto";
import { TemplateCommentaryProvider, personalizeText, type CommentaryProvider } from "./commentaryProvider.js";
import { publish } from "./pubsub.js";
import {
  addCommentary,
  bumpMetric,
  getExternalEventRecord,
  getGame,
  getMetrics,
  getViewerPreferences,
  listCommentary,
  pushRecentEvent,
  recordExternalEvent,
  saveGame,
  setViewerPreferences,
} from "./store.js";
import {
  VALID_EVENT_TYPES,
  type AskQuestionResult,
  type CommentaryLine,
  type GameEvent,
  type GameMetrics,
  type GameState,
  type IncomingGameEvent,
  type StartGameInput,
  type ViewerPreferences,
} from "./types.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

/**
 * The fast path for confidence-gated commentary: a plain template call,
 * bypassing whatever `CommentaryProvider` is configured (which may be a
 * real, per-call-cost LLM). Used for routine, unambiguous events — see
 * `isNotableEvent` below — so a game with a lot of ordinary plays doesn't
 * pay LLM latency/cost for every single one of them.
 */
const fastPathProvider = new TemplateCommentaryProvider();

export function startGame(input: StartGameInput): GameState {
  if (!input?.homeTeam?.trim() || !input?.awayTeam?.trim()) {
    throw new ValidationError("homeTeam and awayTeam are required.");
  }
  const now = new Date().toISOString();
  const game: GameState = {
    id: randomUUID(),
    sport: input.sport?.trim() || "basketball",
    homeTeam: input.homeTeam.trim(),
    awayTeam: input.awayTeam.trim(),
    homeScore: 0,
    awayScore: 0,
    period: 1,
    periodLabel: input.periodLabel?.trim() || "quarter",
    clock: input.initialClock?.trim() || "12:00",
    status: "in_progress",
    recentEvents: [],
    createdAt: now,
    updatedAt: now,
  };
  saveGame(game);
  return game;
}

export function requireGame(gameId: string): GameState {
  const game = getGame(gameId);
  if (!game) {
    throw new NotFoundError(`No game with id "${gameId}".`);
  }
  return game;
}

function isValidEventType(type: unknown): type is IncomingGameEvent["type"] {
  return typeof type === "string" && (VALID_EVENT_TYPES as readonly string[]).includes(type);
}

function applyEventToState(game: GameState, event: GameEvent): void {
  if (event.type === "score") {
    if (event.team === "home") game.homeScore += event.points ?? 0;
    else if (event.team === "away") game.awayScore += event.points ?? 0;
  }
  if (event.type === "period_end") {
    game.period = (event.period ?? game.period) + 1;
  } else if (typeof event.period === "number") {
    game.period = event.period;
  }
  if (typeof event.clock === "string" && event.clock.length > 0) {
    game.clock = event.clock;
  }
  if (event.type === "game_end") {
    game.status = "final";
  }
  game.updatedAt = event.occurredAt;
}

export interface IngestResult {
  game: GameState;
  event: GameEvent;
  commentary: CommentaryLine;
  /** True when this call replayed a previously-seen `externalEventId`: nothing was mutated or (re)generated. */
  duplicate?: boolean;
  /** Which commentary-generation path this event took. Absent on a duplicate replay (nothing was generated this call). */
  path?: "fast" | "escalated";
}

/**
 * Confidence-gated commentary routing: decides whether an event is routine
 * enough for the fast template path, or "notable" enough to escalate to the
 * full (potentially LLM-backed) `CommentaryProvider`. Kept as a small, clear
 * heuristic rather than a model call of its own — the whole point is to
 * avoid spending latency/cost figuring out whether to spend latency/cost:
 *
 * - `game_end` always escalates — the final call deserves the best line.
 * - A `score` escalates when it changes who's leading, or ties a game that
 *   wasn't tied — i.e. a go-ahead or momentum-shifting score. A score that
 *   doesn't change the leader (padding an existing lead) stays fast-path.
 * - A `foul` escalates only when its description flags it as serious
 *   (flagrant/technical/ejection) — routine fouls stay fast-path.
 * - Everything else (turnover, rebound, steal, block, timeout, period_end)
 *   is routine and unambiguous enough to template directly.
 *
 * `priorHomeScore`/`priorAwayScore` must be captured *before* the event is
 * applied to `game`; `game` itself must already reflect the event.
 */
export function isNotableEvent(
  event: GameEvent,
  priorHomeScore: number,
  priorAwayScore: number,
  game: GameState
): boolean {
  if (event.type === "game_end") return true;

  if (event.type === "score") {
    const priorDiff = priorHomeScore - priorAwayScore;
    const newDiff = game.homeScore - game.awayScore;
    if (Math.sign(priorDiff) !== Math.sign(newDiff)) return true; // lead change (incl. breaking a tie)
    if (priorDiff !== 0 && newDiff === 0) return true; // ties a game that was previously decided
    return false;
  }

  if (event.type === "foul") {
    return /flagrant|technical|ejection/i.test(event.description ?? "");
  }

  return false;
}

export async function ingestEvent(
  gameId: string,
  incoming: IncomingGameEvent,
  provider: CommentaryProvider
): Promise<IngestResult> {
  const game = requireGame(gameId);

  if (!isValidEventType(incoming?.type)) {
    throw new ValidationError(
      `Invalid or missing event type. Must be one of: ${VALID_EVENT_TYPES.join(", ")}.`
    );
  }
  if (incoming.type === "score" && (typeof incoming.points !== "number" || incoming.points <= 0)) {
    throw new ValidationError('"score" events require a positive numeric "points" field.');
  }
  if ((incoming.type === "score" || incoming.type === "foul" || incoming.type === "turnover") && !incoming.team && !incoming.player) {
    throw new ValidationError(`"${incoming.type}" events require a "team" or "player" field.`);
  }

  // Idempotent ingestion: replaying an already-seen externalEventId for this
  // game is a clean no-op — no duplicate state mutation, no duplicate
  // commentary/metrics/stream push — returning the original result instead.
  const externalEventId = incoming.externalEventId?.trim();
  if (externalEventId) {
    const existing = getExternalEventRecord(gameId, externalEventId);
    if (existing) {
      return { game, event: existing.event, commentary: existing.commentary, duplicate: true };
    }
  }

  const priorHomeScore = game.homeScore;
  const priorAwayScore = game.awayScore;

  const event: GameEvent = {
    ...incoming,
    id: randomUUID(),
    gameId,
    occurredAt: new Date().toISOString(),
  };

  applyEventToState(game, event);
  pushRecentEvent(game, event);
  saveGame(game);

  const notable = isNotableEvent(event, priorHomeScore, priorAwayScore, game);
  const text = notable
    ? await provider.narrateEvent(game, event)
    : await fastPathProvider.narrateEvent(game, event);
  bumpMetric(gameId, notable ? "escalated" : "fast");

  const commentary: CommentaryLine = {
    id: randomUUID(),
    gameId,
    text,
    eventId: event.id,
    createdAt: new Date().toISOString(),
  };
  addCommentary(gameId, commentary);

  if (externalEventId) {
    recordExternalEvent(gameId, externalEventId, { event, commentary });
  }

  publish(gameId, { type: "commentary", commentary, state: game });

  return { game, event, commentary, path: notable ? "escalated" : "fast" };
}

/**
 * Returns commentary for a game, newest first.
 *
 * `since` supports resuming a feed instead of re-fetching full history: pass
 * either a previously-seen commentary `id` (returns everything strictly
 * newer than that entry — exact, unaffected by clock resolution) or an ISO
 * timestamp (returns entries created after it). Omit for the full history
 * (unchanged, existing behavior).
 *
 * `viewerId` personalizes the returned text per that viewer's stored
 * preferences (see `setPreferences`) without touching the stored, shared
 * commentary — omit for the plain, ungated text.
 */
export function getCommentary(gameId: string, since?: string, viewerId?: string): CommentaryLine[] {
  const game = requireGame(gameId); // 404s cleanly for an unknown game
  const all = listCommentary(gameId); // newest first

  let lines = all;
  if (since) {
    const idIndex = all.findIndex((c) => c.id === since);
    if (idIndex !== -1) {
      lines = all.slice(0, idIndex); // everything newer than the matched entry
    } else {
      const sinceTime = Date.parse(since);
      if (Number.isNaN(sinceTime)) {
        throw new ValidationError('"since" must be a known commentary id or a valid ISO timestamp.');
      }
      lines = all.filter((c) => new Date(c.createdAt).getTime() > sinceTime);
    }
  }

  if (!viewerId) return lines;
  const prefs = getViewerPreferences(gameId, viewerId);
  if (!prefs) return lines;
  return lines.map((line) => ({ ...line, text: personalizeText(line.text, game, prefs) }));
}

export async function askQuestion(
  gameId: string,
  question: string,
  provider: CommentaryProvider,
  viewerId?: string
): Promise<AskQuestionResult> {
  const game = requireGame(gameId);
  if (!question?.trim()) {
    throw new ValidationError('A non-empty "question" field is required.');
  }
  const rawAnswer = await provider.answerQuestion(game, question.trim());
  const prefs = viewerId ? getViewerPreferences(gameId, viewerId) : undefined;
  const answer = personalizeText(rawAnswer, game, prefs);
  return { question: question.trim(), answer, answeredAt: new Date().toISOString() };
}

/** Sets (replacing wholesale) a viewer's commentary preferences for a game. */
export function setPreferences(
  gameId: string,
  viewerId: string,
  input: { favoriteTeam?: unknown; verbosity?: unknown }
): ViewerPreferences {
  requireGame(gameId);
  if (!viewerId?.trim()) {
    throw new ValidationError("A non-empty viewerId is required.");
  }
  if (input?.verbosity !== undefined && input.verbosity !== "concise" && input.verbosity !== "detailed") {
    throw new ValidationError('"verbosity" must be "concise" or "detailed".');
  }
  const prefs: ViewerPreferences = {
    favoriteTeam: typeof input?.favoriteTeam === "string" && input.favoriteTeam.trim() ? input.favoriteTeam.trim() : undefined,
    verbosity: input?.verbosity as ViewerPreferences["verbosity"],
  };
  setViewerPreferences(gameId, viewerId.trim(), prefs);
  return prefs;
}

export function getPreferences(gameId: string, viewerId: string): ViewerPreferences | undefined {
  requireGame(gameId);
  return getViewerPreferences(gameId, viewerId);
}

/** Fast-path vs. escalated commentary-generation counters for a game (see `isNotableEvent`). */
export function getGameMetrics(gameId: string): GameMetrics {
  requireGame(gameId);
  return getMetrics(gameId);
}
