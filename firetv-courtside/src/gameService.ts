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
  addFantasyHighlight,
  addFullEvent,
  addNotableEvent,
  addPartyMember,
  addPartyQnA,
  addPrediction,
  bumpMetric,
  bumpPredictionAccuracy,
  getCommentaryForEvent,
  getExternalEventRecord,
  getFantasyRoster as storeGetFantasyRoster,
  getGame,
  getMetrics,
  getOrCreateParty,
  getOrCreateSubscription,
  getParty,
  getPlayerStats as getPlayerStatsRecord,
  getPrediction,
  getPredictionAccuracy,
  getPredictionAnswer,
  getTeamStats as getTeamStatsRecord,
  getViewerGames,
  getViewerPreferences,
  listFantasyHighlights,
  listFantasyRosters,
  listFullEvents,
  listNotableEvents,
  listOpenPredictions,
  listPartyQnA,
  listPredictionAnswers,
  listPredictions,
  pushRecentEvent,
  recordExternalEvent,
  recordPlayerStat,
  recordPredictionAnswer,
  recordTeamStat,
  recordViewerGame,
  saveGame,
  setFantasyHighlights,
  setFantasyRoster as storeSetFantasyRoster,
  setViewerPreferences,
  listCommentary,
} from "./store.js";
import {
  DEFAULT_LOCALE,
  VALID_EVENT_TYPES,
  VALID_LOCALES,
  type AskQuestionResult,
  type CommentaryLine,
  type CommentaryLocale,
  type EntityStats,
  type FantasyHighlightsResult,
  type GameEvent,
  type GameMetrics,
  type GameState,
  type IncomingGameEvent,
  type NotableEventRecord,
  type PartyQnA,
  type Prediction,
  type PredictionAccuracy,
  type PredictionAnswer,
  type PredictionType,
  type StartGameInput,
  type Subscription,
  type ViewerPreferences,
  type WatchParty,
} from "./types.js";
import { generateSecret, notifySubscribers } from "./webhooks.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

/**
 * Resolves the effective commentary locale for a request: an explicit
 * request-level value wins, then a viewer's stored preference, then the
 * default. Throws on an explicit value that isn't one of `VALID_LOCALES` —
 * unlike a missing/undefined locale, a garbled one is a client error, not
 * something to silently fall back from.
 */
function resolveLocale(explicit: unknown, stored: CommentaryLocale | undefined): CommentaryLocale {
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    if (typeof explicit !== "string" || !(VALID_LOCALES as readonly string[]).includes(explicit)) {
      throw new ValidationError(`"locale" must be one of: ${VALID_LOCALES.join(", ")}.`);
    }
    return explicit as CommentaryLocale;
  }
  return stored ?? DEFAULT_LOCALE;
}

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

  // Live prediction/trivia mode: any prediction still open for this game gets
  // a chance to resolve against this exact event (see `resolveOpenPredictions`)
  // before anything else about the event is processed — a prediction's
  // outcome is a fact about the event itself, independent of notability
  // routing or fantasy tagging below.
  resolveOpenPredictions(gameId, event);
  if (event.type === "game_end") {
    voidOpenPredictions(gameId); // no further event could ever resolve what's left open
  }

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
    path: notable ? "escalated" : "fast",
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

  // Fantasy-relevant play detection: a genuinely different lens on this same
  // event, not a new event type. Any viewer who registered a fantasy roster
  // for this game (see `setFantasyRoster` below) gets this play appended to
  // their own fantasy highlight reel — independent of whether the play was
  // "notable" by broadcast standards, since a routine assist-less bucket or a
  // garbage-time turnover still matters to someone who drafted that player.
  if (event.player) {
    const playerKey = event.player.trim().toLowerCase();
    for (const { viewerId, roster } of listFantasyRosters(gameId)) {
      if (roster.some((name) => name.toLowerCase() === playerKey)) {
        addFantasyHighlight(gameId, viewerId, { event, commentary });
      }
    }
  }

  return { game, event, commentary, path: notable ? "escalated" : "fast" };
}

// --- Live prediction/trivia mode ---------------------------------------------

/**
 * Checks every currently-open prediction for this game against the event
 * that was just ingested, resolving any whose outcome this event actually
 * decides. An event that doesn't bear on a given prediction's question (e.g.
 * a `rebound` while a `next_possession_score` prediction is open) leaves it
 * open for a later event to resolve — this is genuinely driven by real game
 * events, never a canned or immediately-scored question.
 */
function resolveOpenPredictions(gameId: string, event: GameEvent): void {
  for (const prediction of listOpenPredictions(gameId)) {
    let outcome: string | undefined;
    if (prediction.type === "next_possession_score") {
      // A possession ends in a score (yes) or doesn't — a turnover is the
      // cleanest unambiguous "no". Every other event type (foul, rebound,
      // steal, block, timeout, period_end) doesn't by itself end a
      // possession one way or the other, so the prediction stays open.
      if (event.type === "score") outcome = "yes";
      else if (event.type === "turnover") outcome = "no";
    } else if (prediction.type === "next_team_to_score") {
      // Only a score event that actually names a team can resolve this —
      // a score attributed to a player with no team field is inconclusive
      // for this specific question and leaves the prediction open.
      if (event.type === "score" && event.team) outcome = event.team;
    }
    if (outcome !== undefined) {
      resolvePrediction(prediction, outcome, event.id);
    }
  }
}

function resolvePrediction(prediction: Prediction, outcome: string, resolvedEventId: string): void {
  prediction.status = "resolved";
  prediction.outcome = outcome;
  prediction.resolvedEventId = resolvedEventId;
  prediction.resolvedAt = new Date().toISOString();
  for (const answer of listPredictionAnswers(prediction.id)) {
    const correct = answer.answer === outcome;
    answer.correct = correct; // same object reference the store holds — mutated in place, same pattern GameState uses
    bumpPredictionAccuracy(answer.viewerId, correct);
  }
}

/** Retires every still-open prediction for a game once it ends — no further event could ever resolve them, and an unresolved prediction should never silently count against anyone. */
function voidOpenPredictions(gameId: string): void {
  const now = new Date().toISOString();
  for (const prediction of listOpenPredictions(gameId)) {
    prediction.status = "voided";
    prediction.resolvedAt = now;
  }
}

/**
 * Poses a new live prediction tied to the game's real event stream (not a
 * canned question) — see `resolveOpenPredictions` for how a later event
 * actually resolves it. `type` defaults to `"next_possession_score"`.
 */
export function posePrediction(gameId: string, input: { type?: unknown }): Prediction {
  const game = requireGame(gameId);

  let type: PredictionType;
  if (input?.type === undefined) {
    type = "next_possession_score";
  } else if (input.type === "next_possession_score" || input.type === "next_team_to_score") {
    type = input.type;
  } else {
    throw new ValidationError('"type" must be one of: "next_possession_score", "next_team_to_score".');
  }

  const question =
    type === "next_team_to_score"
      ? `Which team scores next: ${game.homeTeam} or ${game.awayTeam}?`
      : "Will the next possession end in a score?";
  const options = type === "next_team_to_score" ? ["home", "away"] : ["yes", "no"];

  const prediction: Prediction = {
    id: randomUUID(),
    gameId,
    type,
    question,
    options,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  addPrediction(prediction);
  return prediction;
}

/** Submits a viewer's answer to a prediction before its outcome is known. Rejects an answer once the prediction has resolved/voided, and rejects a second answer from the same viewer on the same prediction. */
export function answerPrediction(
  gameId: string,
  predictionId: string,
  input: { viewerId?: unknown; answer?: unknown }
): PredictionAnswer {
  requireGame(gameId);
  const prediction = getPrediction(predictionId);
  if (!prediction || prediction.gameId !== gameId) {
    throw new NotFoundError(`No prediction with id "${predictionId}" for this game.`);
  }

  const viewerId = typeof input?.viewerId === "string" ? input.viewerId.trim() : "";
  if (!viewerId) {
    throw new ValidationError("A non-empty viewerId is required.");
  }
  const answer = typeof input?.answer === "string" ? input.answer.trim().toLowerCase() : "";
  if (!answer) {
    throw new ValidationError('A non-empty "answer" is required.');
  }
  if (!prediction.options.includes(answer)) {
    throw new ValidationError(`"answer" must be one of: ${prediction.options.join(", ")}.`);
  }
  if (prediction.status !== "open") {
    throw new ValidationError(`Prediction "${predictionId}" is no longer open for answers.`);
  }
  if (getPredictionAnswer(predictionId, viewerId)) {
    throw new ValidationError(`Viewer "${viewerId}" has already answered this prediction.`);
  }

  const record: PredictionAnswer = { predictionId, viewerId, answer, submittedAt: new Date().toISOString() };
  recordPredictionAnswer(record);
  return record;
}

/** Every prediction posed for a game (open, resolved, and voided), newest first. */
export function listGamePredictions(gameId: string): Prediction[] {
  requireGame(gameId);
  return listPredictions(gameId);
}

/** One prediction plus every answer submitted for it — useful for a client polling to see whether/how a specific prediction resolved. */
export function getPredictionDetail(gameId: string, predictionId: string): { prediction: Prediction; answers: PredictionAnswer[] } {
  requireGame(gameId);
  const prediction = getPrediction(predictionId);
  if (!prediction || prediction.gameId !== gameId) {
    throw new NotFoundError(`No prediction with id "${predictionId}" for this game.`);
  }
  return { prediction, answers: listPredictionAnswers(predictionId) };
}

/** A viewer's running prediction accuracy across every game — zeroed (not an error) for a viewer who has never answered a prediction. */
export function getViewerPredictionAccuracy(viewerId: string): PredictionAccuracy {
  const id = typeof viewerId === "string" ? viewerId.trim() : "";
  if (!id) {
    throw new ValidationError("A non-empty viewerId is required.");
  }
  return getPredictionAccuracy(id);
}

// --- Fantasy-relevant play detection -----------------------------------------

/**
 * Registers (replacing wholesale) a viewer's fantasy roster for a game, and
 * immediately backfills their fantasy highlight reel from every event
 * already ingested for this game — a viewer who registers mid-game
 * shouldn't lose the plays their rostered players already made before they
 * got around to setting up their roster.
 */
export function setFantasyRoster(gameId: string, viewerId: string, input: { players?: unknown }): FantasyHighlightsResult {
  requireGame(gameId);
  const id = typeof viewerId === "string" ? viewerId.trim() : "";
  if (!id) {
    throw new ValidationError("A non-empty viewerId is required.");
  }
  if (!Array.isArray(input?.players) || input.players.length === 0) {
    throw new ValidationError('A non-empty "players" array of player names is required.');
  }
  const seen = new Set<string>();
  const roster: string[] = [];
  for (const raw of input.players) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roster.push(name);
  }
  if (roster.length === 0) {
    throw new ValidationError('"players" must contain at least one non-empty player name.');
  }

  storeSetFantasyRoster(gameId, id, roster);

  // Backfill: scan the game's full (uncapped) event history — already
  // newest-first, so the rebuilt reel comes out newest-first too — for any
  // play naming a rostered player, pairing it with the commentary already
  // generated for that event.
  const rosterKeys = new Set(roster.map((name) => name.toLowerCase()));
  const backfilled: NotableEventRecord[] = [];
  for (const event of listFullEvents(gameId)) {
    if (event.player && rosterKeys.has(event.player.trim().toLowerCase())) {
      const commentary = getCommentaryForEvent(gameId, event.id);
      if (commentary) backfilled.push({ event, commentary });
    }
  }
  setFantasyHighlights(gameId, id, backfilled);

  return { gameId, viewerId: id, roster, highlights: backfilled };
}

/** A viewer's fantasy roster + highlight reel for a game — an empty (not error) result for a viewer who hasn't registered a roster yet. */
export function getFantasyHighlights(gameId: string, viewerId: string): FantasyHighlightsResult {
  requireGame(gameId);
  const id = typeof viewerId === "string" ? viewerId.trim() : "";
  if (!id) {
    throw new ValidationError("A non-empty viewerId is required.");
  }
  const roster = storeGetFantasyRoster(gameId, id) ?? [];
  return { gameId, viewerId: id, roster, highlights: listFantasyHighlights(gameId, id) };
}

// --- Shared watch-party sessions ----------------------------------------------

export interface CreatePartyResult {
  party: WatchParty;
  /** False when this call matched an existing party of the same (case-insensitive) name for this game instead of creating a new one. */
  created: boolean;
}

/** Creates (or, idempotently, returns) a named watch party for a game, optionally joining `viewerId` to it in the same call. */
export function createParty(gameId: string, input: { name?: unknown; viewerId?: unknown }): CreatePartyResult {
  requireGame(gameId);
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new ValidationError('A non-empty "name" is required.');
  }
  const result = getOrCreateParty(gameId, name, () => ({
    id: randomUUID(),
    gameId,
    name,
    members: [],
    createdAt: new Date().toISOString(),
  }));
  const viewerId = typeof input?.viewerId === "string" ? input.viewerId.trim() : "";
  if (viewerId) {
    addPartyMember(result.party.id, viewerId);
  }
  return result;
}

/** Joins a viewer to an existing watch party. Idempotent — joining twice just confirms membership. */
export function joinParty(gameId: string, partyId: string, viewerId: string): WatchParty {
  requireGame(gameId);
  const party = getParty(partyId);
  if (!party || party.gameId !== gameId) {
    throw new NotFoundError(`No watch party with id "${partyId}" for this game.`);
  }
  const id = typeof viewerId === "string" ? viewerId.trim() : "";
  if (!id) {
    throw new ValidationError("A non-empty viewerId is required.");
  }
  return addPartyMember(partyId, id)!;
}

export function getPartyInfo(gameId: string, partyId: string): WatchParty {
  requireGame(gameId);
  const party = getParty(partyId);
  if (!party || party.gameId !== gameId) {
    throw new NotFoundError(`No watch party with id "${partyId}" for this game.`);
  }
  return party;
}

/** The durable history of every Q&A shared into a party so far, newest first — the same records also pushed live over SSE the instant they're asked (see `askQuestion`). */
export function getPartyQnAHistory(gameId: string, partyId: string): PartyQnA[] {
  getPartyInfo(gameId, partyId); // 404s cleanly for an unknown game or party
  return listPartyQnA(partyId);
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
 *
 * `locale` (or, absent that, the viewer's stored `preferences.locale`)
 * requests a different commentary pack (see `CommentaryLocale`) than the
 * one each line was originally generated in. Since commentary is generated
 * once per event and shared across every viewer (a broadcast, not a
 * per-viewer LLM call — see `personalizeText`'s doc comment), a non-default
 * locale is produced by regenerating each line fresh from its underlying
 * event via the same commentary-generation path (`fast`/`escalated`, see
 * `CommentaryLine.path`) it originally took, rather than by mutating the
 * shared stored text — so the default-locale read path above stays exactly
 * as cheap as it always was.
 */
export async function getCommentary(
  gameId: string,
  since: string | undefined,
  viewerId: string | undefined,
  provider: CommentaryProvider,
  explicitLocale?: unknown
): Promise<CommentaryLine[]> {
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

  const prefs = viewerId ? getViewerPreferences(gameId, viewerId) : undefined;
  const locale = resolveLocale(explicitLocale, prefs?.locale);

  if (locale === DEFAULT_LOCALE) {
    if (!prefs) return lines;
    return lines.map((line) => ({ ...line, text: personalizeText(line.text, game, prefs) }));
  }

  const eventsById = new Map(listFullEvents(gameId).map((e) => [e.id, e]));
  const regenerated: CommentaryLine[] = [];
  for (const line of lines) {
    const event = line.eventId ? eventsById.get(line.eventId) : undefined;
    let text = line.text;
    if (event) {
      const generator = line.path === "fast" ? fastPathProvider : provider;
      text = await generator.narrateEvent(game, event, locale);
    }
    if (prefs) text = personalizeText(text, game, prefs);
    regenerated.push({ ...line, text });
  }
  return regenerated;
}

/**
 * Answers a viewer's question, optionally in a requested `locale` and
 * optionally shared into a watch-party session via `partyId` — see "Shared
 * watch-party session" for how a `partyId`d question stops being private to
 * the asker.
 */
export async function askQuestion(
  gameId: string,
  question: string,
  provider: CommentaryProvider,
  viewerId?: string,
  options?: { partyId?: unknown; locale?: unknown }
): Promise<AskQuestionResult> {
  const game = requireGame(gameId);
  if (!question?.trim()) {
    throw new ValidationError('A non-empty "question" field is required.');
  }
  const trimmedViewer = viewerId?.trim();
  if (trimmedViewer) {
    recordViewerGame(trimmedViewer, gameId); // powers GET /watchlist — "games this viewer has interacted with"
  }

  const prefs = trimmedViewer ? getViewerPreferences(gameId, trimmedViewer) : undefined;
  const locale = resolveLocale(options?.locale, prefs?.locale);

  const rawAnswer = await provider.answerQuestion(game, question.trim(), locale);
  const answer = personalizeText(rawAnswer, game, prefs);

  const partyIdInput = typeof options?.partyId === "string" ? options.partyId.trim() : "";
  let partyId: string | undefined;
  if (partyIdInput) {
    if (!trimmedViewer) {
      throw new ValidationError('Sharing a question into a watch party ("partyId") requires a "viewerId".');
    }
    const party = getParty(partyIdInput);
    if (!party || party.gameId !== gameId) {
      throw new NotFoundError(`No watch party with id "${partyIdInput}" for this game.`);
    }
    addPartyMember(partyIdInput, trimmedViewer); // asking into a party doubles as joining it
    partyId = partyIdInput;

    const record: PartyQnA = {
      id: randomUUID(),
      gameId,
      partyId,
      viewerId: trimmedViewer,
      question: question.trim(),
      answer,
      askedAt: new Date().toISOString(),
    };
    addPartyQnA(record);
    // Reuses the game's existing SSE stream (see `GET /games/:id/stream`) —
    // every party member watching this game already has that connection
    // open, so the shared Q&A rides the same pipe commentary already uses,
    // just tagged with a distinct `type` and `partyId` so a client can
    // filter it into a party-chat view instead of the narration feed.
    publish(gameId, { type: "party_qa", partyQnA: record });
  }

  return { question: question.trim(), answer, answeredAt: new Date().toISOString(), partyId };
}

/** Sets (replacing wholesale) a viewer's commentary preferences for a game. */
export function setPreferences(
  gameId: string,
  viewerId: string,
  input: { favoriteTeam?: unknown; verbosity?: unknown; locale?: unknown }
): ViewerPreferences {
  requireGame(gameId);
  if (!viewerId?.trim()) {
    throw new ValidationError("A non-empty viewerId is required.");
  }
  if (input?.verbosity !== undefined && input.verbosity !== "concise" && input.verbosity !== "detailed") {
    throw new ValidationError('"verbosity" must be "concise" or "detailed".');
  }
  if (input?.locale !== undefined && !(VALID_LOCALES as readonly string[]).includes(input.locale as string)) {
    throw new ValidationError(`"locale" must be one of: ${VALID_LOCALES.join(", ")}.`);
  }
  const prefs: ViewerPreferences = {
    favoriteTeam: typeof input?.favoriteTeam === "string" && input.favoriteTeam.trim() ? input.favoriteTeam.trim() : undefined,
    verbosity: input?.verbosity as ViewerPreferences["verbosity"],
    locale: input?.locale as CommentaryLocale | undefined,
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
  provider: CommentaryProvider,
  explicitLocale?: unknown
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

  const locale = resolveLocale(explicitLocale, undefined);
  const summary = await provider.generateRecap(game, chronoEvents, chronoCommentary, windowLabel, locale);

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
