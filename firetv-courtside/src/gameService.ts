import { randomUUID } from "node:crypto";
import {
  defaultPeriodLabel,
  isSeriousFoulDescription,
  personalizeText,
  TemplateCommentaryProvider,
  type CommentaryProvider,
} from "./commentaryProvider.js";
import { publish } from "./pubsub.js";
import {
  addCommentary,
  addFullEvent,
  addNotableEvent,
  bumpMetric,
  getExternalEventRecord,
  getGame,
  getMetrics,
  getOrCreateSubscription,
  getPlayerStats as getPlayerStatsRecord,
  getTeamStats as getTeamStatsRecord,
  getViewerGames,
  getViewerPreferences,
  listCommentary,
  listFullEvents,
  listNotableEvents,
  pushRecentEvent,
  recordExternalEvent,
  recordPlayerStat,
  recordTeamStat,
  recordViewerGame,
  saveGame,
  setViewerPreferences,
} from "./store.js";
import {
  VALID_EVENT_TYPES,
  type AskQuestionResult,
  type CommentaryLine,
  type EntityStats,
  type GameEvent,
  type GameMetrics,
  type GameState,
  type IncomingGameEvent,
  type NotableEventRecord,
  type StartGameInput,
  type Subscription,
  type ViewerPreferences,
} from "./types.js";
import { generateSecret, notifySubscribers } from "./webhooks.js";

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
    periodLabel: input.periodLabel?.trim() || defaultPeriodLabel(input.sport),
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
    return isSeriousFoulDescription(game.sport, event.description);
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
  addFullEvent(gameId, event); // uncapped, unlike recentEvents — powers GET /games/:id/recap
  saveGame(game);

  const notable = isNotableEvent(event, priorHomeScore, priorAwayScore, game);

  // Season-long stats aggregation (GET /stats/team/:teamName, GET /stats/player/:playerName):
  // folds this event into whichever team/player it names, across every game ever ingested.
  const eventTeamName = event.team === "home" ? game.homeTeam : event.team === "away" ? game.awayTeam : undefined;
  const eventPoints = event.type === "score" ? event.points ?? 0 : 0;
  if (eventTeamName) recordTeamStat(eventTeamName, gameId, event.type, eventPoints, notable);
  if (event.player) recordPlayerStat(event.player, gameId, event.type, eventPoints, notable);
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

  // Highlights + outbound score alerts both key off the same notability
  // signal already computed above — see "Game archive & highlights" and
  // "Outbound score-alert subscriptions" in the README. `notifySubscribers`
  // is deliberately not awaited: delivery (and any retries) must never add
  // latency to the request that ingested the play.
  if (notable) {
    addNotableEvent(gameId, { event, commentary });
    notifySubscribers(gameId, event, commentary);
  }

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
  if (viewerId?.trim()) {
    recordViewerGame(viewerId.trim(), gameId); // powers GET /watchlist — "games this viewer has interacted with"
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
  recordViewerGame(viewerId.trim(), gameId); // powers GET /watchlist — "games this viewer has interacted with"
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

// --- Game archive & highlights ---------------------------------------------

export interface HighlightsResult {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  status: GameState["status"];
  homeScore: number;
  awayScore: number;
  /** Notable moments only (see `isNotableEvent`), newest first. Populated live — a game that hasn't ended yet still returns highlights-so-far. */
  highlights: NotableEventRecord[];
}

/**
 * A shareable recap of a game's notable moments — reuses the exact same
 * `isNotableEvent` signal that drives confidence-gated commentary routing
 * (see `ingestEvent`) rather than a second, separate notion of "highlight
 * worthy". Works identically for an in-progress game (highlights-so-far) and
 * a finished one (the full recap, since `game_end` always qualifies).
 */
export function getHighlights(gameId: string): HighlightsResult {
  const game = requireGame(gameId);
  return {
    gameId: game.id,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    status: game.status,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    highlights: listNotableEvents(gameId), // already newest-first
  };
}

// --- Outbound score-alert subscriptions -------------------------------------

export interface SubscribeResult {
  subscription: Subscription;
  /** False when this call matched an existing (gameId, callbackUrl) registration instead of creating a new one. */
  created: boolean;
}

/**
 * Registers a webhook to be POSTed a signed alert whenever a notable event
 * happens in `gameId` (see `webhooks.ts`). Idempotent on (gameId,
 * callbackUrl, playerName) — registering the same callback (with the same
 * optional player filter) twice for the same game returns the original
 * subscription (same id, same secret) rather than creating a duplicate that
 * would double-fire every alert.
 *
 * An optional `playerName` scopes delivery to only notable events naming
 * that player (see `notifySubscribers` in webhooks.ts) — e.g. a fan who only
 * cares about their favorite player's moments, not every notable event in
 * the game. Omitting it keeps the original round-3 behavior (every notable
 * event in the game).
 */
export function subscribeToGame(
  gameId: string,
  input: { callbackUrl?: unknown; viewerId?: unknown; playerName?: unknown }
): SubscribeResult {
  requireGame(gameId);

  const callbackUrl = typeof input?.callbackUrl === "string" ? input.callbackUrl.trim() : "";
  if (!callbackUrl) {
    throw new ValidationError('A non-empty "callbackUrl" field is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new ValidationError('"callbackUrl" must be a valid URL.');
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError('"callbackUrl" must be an http:// or https:// URL.');
  }

  const viewerId = typeof input?.viewerId === "string" && input.viewerId.trim() ? input.viewerId.trim() : undefined;
  const playerName = typeof input?.playerName === "string" && input.playerName.trim() ? input.playerName.trim() : undefined;

  return getOrCreateSubscription(gameId, callbackUrl, playerName, () => ({
    id: randomUUID(),
    gameId,
    callbackUrl,
    viewerId,
    playerName,
    secret: generateSecret(),
    createdAt: new Date().toISOString(),
  }));
}

// --- Multi-game watchlist ----------------------------------------------------

export interface WatchlistEntry extends NotableEventRecord {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
}

export interface WatchlistResult {
  viewerId: string;
  /** Every game this viewer has interacted with (asked a question on, or set preferences for). */
  gameIds: string[];
  /** Notable events across all of those games, newest first regardless of which game they happened in. */
  highlights: WatchlistEntry[];
}

/**
 * "What did I miss across all my games?" — aggregates notable events across
 * every game a viewer has asked a question on or set preferences for (see
 * `recordViewerGame` call sites in `askQuestion`/`setPreferences`), ordered
 * newest-first across games rather than grouped per game.
 */
export function getWatchlist(viewerId: string): WatchlistResult {
  if (!viewerId?.trim()) {
    throw new ValidationError('A non-empty "viewerId" query parameter is required.');
  }
  const id = viewerId.trim();
  const gameIds = getViewerGames(id);

  const highlights: WatchlistEntry[] = [];
  for (const gameId of gameIds) {
    const game = getGame(gameId);
    if (!game) continue; // defensive: shouldn't happen, games are never deleted
    for (const record of listNotableEvents(gameId)) {
      highlights.push({ gameId, homeTeam: game.homeTeam, awayTeam: game.awayTeam, ...record });
    }
  }
  highlights.sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt));

  return { viewerId: id, gameIds, highlights };
}

// --- Season-long stats aggregation -------------------------------------------

/** A team's cumulative stats across every game ingested this process has seen. Zeroed (not a 404) for a team that's never appeared in an event — there's no separate "team" resource to have missed. */
export function getTeamStats(teamName: string): EntityStats {
  const name = typeof teamName === "string" ? teamName.trim() : "";
  if (!name) {
    throw new ValidationError("A non-empty team name is required.");
  }
  return getTeamStatsRecord(name);
}

/** A player's cumulative stats across every game ingested this process has seen. Zeroed (not a 404) for a player that's never appeared in an event. */
export function getPlayerStats(playerName: string): EntityStats {
  const name = typeof playerName === "string" ? playerName.trim() : "";
  if (!name) {
    throw new ValidationError("A non-empty player name is required.");
  }
  return getPlayerStatsRecord(name);
}

// --- "Catch-up" recap -------------------------------------------------------

export interface RecapOptions {
  /** Recap everything from this many minutes ago until now. Mutually exclusive with `since` (since is preferred if both are given). */
  sinceMinutes?: number;
  /** Recap everything strictly after this commentary-id or ISO-timestamp cursor — same style as `GET /games/:id/commentary?since=`. */
  since?: string;
}

export interface RecapResult {
  gameId: string;
  /** Human-readable description of the window that was recapped. */
  windowLabel: string;
  sinceMinutes?: number;
  since?: string;
  /** How many events fell inside the window. */
  eventCount: number;
  /** The natural-language summary, generated by the same `CommentaryProvider` used for event narration/Q&A (template fallback included). */
  summary: string;
  generatedAt: string;
}

/**
 * "Catch-up" recap: a natural-language summary of everything that happened
 * in a window, generated via the same `CommentaryProvider` seam that
 * narrates events and answers questions (so a real Bedrock-backed provider
 * summarizes it; `TemplateCommentaryProvider` gives a deterministic
 * fallback) — rather than just handing back the raw commentary lines.
 *
 * The window is expressed either as `sinceMinutes` (a rolling time window
 * ending now) or `since` (a commentary-id or ISO-timestamp cursor, in the
 * same style as `GET /games/:id/commentary?since=`); `since` wins if both
 * are given. Neither given recaps the whole game so far.
 */
export async function getRecap(
  gameId: string,
  options: RecapOptions,
  provider: CommentaryProvider
): Promise<RecapResult> {
  const game = requireGame(gameId);
  const allEvents = listFullEvents(gameId); // newest first, uncapped
  const allCommentary = listCommentary(gameId); // newest first

  let windowEvents: GameEvent[];
  let windowCommentary: CommentaryLine[];
  let windowLabel: string;

  if (options.since !== undefined) {
    const since = options.since;
    const idIndex = allCommentary.findIndex((c) => c.id === since);
    let cutoffTime: number;
    if (idIndex !== -1) {
      windowCommentary = allCommentary.slice(0, idIndex); // everything newer than the matched entry
      cutoffTime = new Date(allCommentary[idIndex].createdAt).getTime();
    } else {
      const parsed = Date.parse(since);
      if (Number.isNaN(parsed)) {
        throw new ValidationError('"since" must be a known commentary id or a valid ISO timestamp.');
      }
      cutoffTime = parsed;
      windowCommentary = allCommentary.filter((c) => new Date(c.createdAt).getTime() > cutoffTime);
    }
    windowEvents = allEvents.filter((e) => new Date(e.occurredAt).getTime() > cutoffTime);
    windowLabel = `since ${since}`;
  } else if (options.sinceMinutes !== undefined) {
    const minutes = options.sinceMinutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      throw new ValidationError('"sinceMinutes" must be a positive number.');
    }
    const cutoffTime = Date.now() - minutes * 60_000;
    windowEvents = allEvents.filter((e) => new Date(e.occurredAt).getTime() >= cutoffTime);
    windowCommentary = allCommentary.filter((c) => new Date(c.createdAt).getTime() >= cutoffTime);
    windowLabel = `in the last ${minutes} minute${minutes === 1 ? "" : "s"}`;
  } else {
    windowEvents = allEvents;
    windowCommentary = allCommentary;
    windowLabel = "so far this game";
  }

  // Provider input reads chronologically (oldest first) — a narrative recap,
  // not the newest-first order the rest of the API uses for feeds.
  const chronoEvents = [...windowEvents].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const chronoCommentary = [...windowCommentary].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const summary = await provider.generateRecap(game, chronoEvents, chronoCommentary, windowLabel);

  return {
    gameId: game.id,
    windowLabel,
    sinceMinutes: options.sinceMinutes,
    since: options.since,
    eventCount: chronoEvents.length,
    summary,
    generatedAt: new Date().toISOString(),
  };
}
