import type {
  CommentaryLine,
  EntityStats,
  EventType,
  GameEvent,
  GameMetrics,
  GameState,
  NotableEventRecord,
  PartyQnA,
  Prediction,
  PredictionAccuracy,
  PredictionAnswer,
  Subscription,
  ViewerPreferences,
  WatchParty,
} from "./types.js";

const MAX_RECENT_EVENTS = 15;

const games = new Map<string, GameState>();
const commentaryByGame = new Map<string, CommentaryLine[]>(); // newest first

/** Idempotency ledger for `externalEventId`: gameId -> externalEventId -> the original ingest's event+commentary. */
const externalEventsByGame = new Map<string, Map<string, { event: GameEvent; commentary: CommentaryLine }>>();

/** Fast-path vs escalated commentary-generation counters, per game. */
const metricsByGame = new Map<string, GameMetrics>();

/** Per-viewer preferences, keyed by gameId -> viewerId. */
const preferencesByGame = new Map<string, Map<string, ViewerPreferences>>();

/** Notable events (highlights) per game, newest first, uncapped. See `isNotableEvent` in gameService.ts. */
const notableEventsByGame = new Map<string, NotableEventRecord[]>();

/** Outbound score-alert subscriptions, keyed by gameId -> (callbackUrl, optionally +playerName) idempotency key — see `subscriptionKey`. */
const subscriptionsByGame = new Map<string, Map<string, Subscription>>();

/** Every gameId a viewer has interacted with (asked a question on, or set preferences for) — powers `GET /watchlist`. */
const gamesByViewer = new Map<string, Set<string>>();

/** Every event ever ingested per game, newest first, uncapped — unlike `GameState.recentEvents` (capped for the live overlay). Powers `GET /games/:id/recap`. */
const allEventsByGame = new Map<string, GameEvent[]>();

/** Season-long cumulative stats, keyed by lowercased/trimmed team or player name so casing doesn't fragment a season total. */
interface StatsAccumulator {
  name: string; // display name, first-seen casing
  gameIds: Set<string>;
  points: number;
  eventCounts: Map<EventType, number>;
  notableEvents: number;
}
const teamStatsByKey = new Map<string, StatsAccumulator>();
const playerStatsByKey = new Map<string, StatsAccumulator>();

/** A viewer's fantasy roster per game — gameId -> viewerId -> player names (display casing). */
const fantasyRostersByGame = new Map<string, Map<string, string[]>>();

/** A viewer's fantasy highlight reel per game, newest first — gameId -> viewerId -> records. */
const fantasyHighlightsByGame = new Map<string, Map<string, NotableEventRecord[]>>();

/** Predictions per game, insertion order preserved (iterated newest-first by callers). */
const predictionsByGame = new Map<string, Prediction[]>();
const predictionsById = new Map<string, Prediction>();

/** Answers per prediction, keyed by viewerId. */
const answersByPrediction = new Map<string, Map<string, PredictionAnswer>>();

/** Running prediction accuracy per viewer, across every game. */
const predictionAccuracyByViewer = new Map<string, { correct: number; total: number }>();

/** Watch parties per game, keyed by id; a second index resolves (gameId, lowercased name) -> id for idempotent creation. */
const partiesById = new Map<string, WatchParty>();
const partyIdByGameAndName = new Map<string, Map<string, string>>();

/** Shared Q&A history per party, newest first. */
const qnaByParty = new Map<string, PartyQnA[]>();

export function saveGame(game: GameState): void {
  games.set(game.id, game);
}

export function getGame(id: string): GameState | undefined {
  return games.get(id);
}

export function listGames(): GameState[] {
  return [...games.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Pushes an event onto a game's recent-events log, newest first, capped in length. */
export function pushRecentEvent(game: GameState, event: GameState["recentEvents"][number]): void {
  game.recentEvents.unshift(event);
  if (game.recentEvents.length > MAX_RECENT_EVENTS) {
    game.recentEvents.length = MAX_RECENT_EVENTS;
  }
}

export function addCommentary(gameId: string, line: CommentaryLine): void {
  const existing = commentaryByGame.get(gameId) ?? [];
  existing.unshift(line); // newest first
  commentaryByGame.set(gameId, existing);
}

export function listCommentary(gameId: string): CommentaryLine[] {
  return commentaryByGame.get(gameId) ?? [];
}

// --- Idempotent ingestion -------------------------------------------------

export function getExternalEventRecord(
  gameId: string,
  externalEventId: string
): { event: GameEvent; commentary: CommentaryLine } | undefined {
  return externalEventsByGame.get(gameId)?.get(externalEventId);
}

export function recordExternalEvent(
  gameId: string,
  externalEventId: string,
  record: { event: GameEvent; commentary: CommentaryLine }
): void {
  let byExternalId = externalEventsByGame.get(gameId);
  if (!byExternalId) {
    byExternalId = new Map();
    externalEventsByGame.set(gameId, byExternalId);
  }
  byExternalId.set(externalEventId, record);
}

// --- Fast-path/escalated commentary metrics -------------------------------

export function bumpMetric(gameId: string, path: "fast" | "escalated"): void {
  const current = metricsByGame.get(gameId) ?? { fastPathCount: 0, escalatedCount: 0 };
  if (path === "fast") current.fastPathCount += 1;
  else current.escalatedCount += 1;
  metricsByGame.set(gameId, current);
}

export function getMetrics(gameId: string): GameMetrics {
  return metricsByGame.get(gameId) ?? { fastPathCount: 0, escalatedCount: 0 };
}

// --- Per-viewer preferences -------------------------------------------------

export function setViewerPreferences(gameId: string, viewerId: string, prefs: ViewerPreferences): void {
  let byViewer = preferencesByGame.get(gameId);
  if (!byViewer) {
    byViewer = new Map();
    preferencesByGame.set(gameId, byViewer);
  }
  byViewer.set(viewerId, prefs);
}

export function getViewerPreferences(gameId: string, viewerId: string): ViewerPreferences | undefined {
  return preferencesByGame.get(gameId)?.get(viewerId);
}

// --- Highlights (notable events) -------------------------------------------

/** Records a notable event + its commentary onto a game's highlight reel, newest first. */
export function addNotableEvent(gameId: string, record: NotableEventRecord): void {
  const existing = notableEventsByGame.get(gameId) ?? [];
  existing.unshift(record);
  notableEventsByGame.set(gameId, existing);
}

/** A game's highlight reel so far (newest first) — works whether or not the game has ended. */
export function listNotableEvents(gameId: string): NotableEventRecord[] {
  return notableEventsByGame.get(gameId) ?? [];
}

// --- Outbound score-alert subscriptions -------------------------------------

/** The idempotency key for a subscription: (gameId is the outer map, this is the inner key) callbackUrl alone, or callbackUrl+playerName for a player-scoped subscription — so the same callback can hold one game-wide subscription and separately one per favorite player without colliding. */
function subscriptionKey(callbackUrl: string, playerName?: string): string {
  return playerName ? `${callbackUrl}::player:${playerName.trim().toLowerCase()}` : callbackUrl;
}

/**
 * Registers a subscription, idempotent on (gameId, callbackUrl, playerName):
 * a second registration of the same callback (and, if given, the same
 * player filter) for the same game returns the original subscription (same
 * id, same secret) instead of creating a duplicate. `create` is only invoked
 * when no existing subscription matches.
 */
export function getOrCreateSubscription(
  gameId: string,
  callbackUrl: string,
  playerName: string | undefined,
  create: () => Subscription
): { subscription: Subscription; created: boolean } {
  let byKey = subscriptionsByGame.get(gameId);
  if (!byKey) {
    byKey = new Map();
    subscriptionsByGame.set(gameId, byKey);
  }
  const key = subscriptionKey(callbackUrl, playerName);
  const existing = byKey.get(key);
  if (existing) {
    return { subscription: existing, created: false };
  }
  const subscription = create();
  byKey.set(key, subscription);
  return { subscription, created: true };
}

/** Every subscription registered on a game — the fan-out list for a notable event. */
export function listSubscriptions(gameId: string): Subscription[] {
  return [...(subscriptionsByGame.get(gameId)?.values() ?? [])];
}

// --- Viewer <-> game interaction tracking (for the watchlist) --------------

/** Records that a viewer interacted with a game (asked a question, or set preferences). */
export function recordViewerGame(viewerId: string, gameId: string): void {
  let games = gamesByViewer.get(viewerId);
  if (!games) {
    games = new Set();
    gamesByViewer.set(viewerId, games);
  }
  games.add(gameId);
}

/** Every gameId a viewer has interacted with, in no particular order. */
export function getViewerGames(viewerId: string): string[] {
  return [...(gamesByViewer.get(viewerId) ?? [])];
}

// --- Full uncapped per-game event log (recap) -------------------------------

/** Appends an event to a game's uncapped event log, newest first. Powers time/cursor-windowed recaps. */
export function addFullEvent(gameId: string, event: GameEvent): void {
  const existing = allEventsByGame.get(gameId) ?? [];
  existing.unshift(event);
  allEventsByGame.set(gameId, existing);
}

/** A game's entire event history so far, newest first. */
export function listFullEvents(gameId: string): GameEvent[] {
  return allEventsByGame.get(gameId) ?? [];
}

// --- Season-long team/player stats -------------------------------------------

function bumpStats(map: Map<string, StatsAccumulator>, name: string, gameId: string, eventType: EventType, points: number, notable: boolean): void {
  const key = name.trim().toLowerCase();
  let rec = map.get(key);
  if (!rec) {
    rec = { name: name.trim(), gameIds: new Set(), points: 0, eventCounts: new Map(), notableEvents: 0 };
    map.set(key, rec);
  }
  rec.gameIds.add(gameId);
  rec.points += points;
  rec.eventCounts.set(eventType, (rec.eventCounts.get(eventType) ?? 0) + 1);
  if (notable) rec.notableEvents += 1;
}

/** Folds one event into a team's season-long cumulative stats. Call once per ingested (non-duplicate) event that names a team. */
export function recordTeamStat(teamName: string, gameId: string, eventType: EventType, points: number, notable: boolean): void {
  bumpStats(teamStatsByKey, teamName, gameId, eventType, points, notable);
}

/** Folds one event into a player's season-long cumulative stats. Call once per ingested (non-duplicate) event that names a player. */
export function recordPlayerStat(playerName: string, gameId: string, eventType: EventType, points: number, notable: boolean): void {
  bumpStats(playerStatsByKey, playerName, gameId, eventType, points, notable);
}

function toEntityStats(requestedName: string, rec: StatsAccumulator | undefined): EntityStats {
  if (!rec) return { name: requestedName, gamesPlayed: 0, points: 0, eventCounts: {}, notableEvents: 0 };
  const eventCounts: Partial<Record<EventType, number>> = {};
  for (const [type, count] of rec.eventCounts) eventCounts[type] = count;
  return { name: rec.name, gamesPlayed: rec.gameIds.size, points: rec.points, eventCounts, notableEvents: rec.notableEvents };
}

/** A team's season-long aggregate across every game ingested. Zeroed (not an error) for a team never seen in an event. */
export function getTeamStats(teamName: string): EntityStats {
  const trimmed = teamName.trim();
  return toEntityStats(trimmed, teamStatsByKey.get(trimmed.toLowerCase()));
}

/** A player's season-long aggregate across every game ingested. Zeroed (not an error) for a player never seen in an event. */
export function getPlayerStats(playerName: string): EntityStats {
  const trimmed = playerName.trim();
  return toEntityStats(trimmed, playerStatsByKey.get(trimmed.toLowerCase()));
}

// --- Fantasy rosters & highlights --------------------------------------------

/** Replaces a viewer's fantasy roster for a game wholesale (same "set, don't merge" spirit as `setViewerPreferences`). */
export function setFantasyRoster(gameId: string, viewerId: string, players: string[]): void {
  let byViewer = fantasyRostersByGame.get(gameId);
  if (!byViewer) {
    byViewer = new Map();
    fantasyRostersByGame.set(gameId, byViewer);
  }
  byViewer.set(viewerId, players);
}

export function getFantasyRoster(gameId: string, viewerId: string): string[] | undefined {
  return fantasyRostersByGame.get(gameId)?.get(viewerId);
}

/** Every (viewerId, roster) pair registered for a game — iterated by `ingestEvent` to tag new plays live. */
export function listFantasyRosters(gameId: string): Array<{ viewerId: string; roster: string[] }> {
  const byViewer = fantasyRostersByGame.get(gameId);
  if (!byViewer) return [];
  return [...byViewer.entries()].map(([viewerId, roster]) => ({ viewerId, roster }));
}

/** Replaces a viewer's fantasy highlight reel wholesale — used to (re)compute the backfill the moment a roster is (re)registered. */
export function setFantasyHighlights(gameId: string, viewerId: string, records: NotableEventRecord[]): void {
  let byViewer = fantasyHighlightsByGame.get(gameId);
  if (!byViewer) {
    byViewer = new Map();
    fantasyHighlightsByGame.set(gameId, byViewer);
  }
  byViewer.set(viewerId, records);
}

/** Appends one newly-ingested play onto a viewer's fantasy highlight reel, newest first — used for live tagging after registration. */
export function addFantasyHighlight(gameId: string, viewerId: string, record: NotableEventRecord): void {
  const byViewer = fantasyHighlightsByGame.get(gameId);
  const existing = byViewer?.get(viewerId) ?? [];
  existing.unshift(record);
  if (byViewer) byViewer.set(viewerId, existing);
  else fantasyHighlightsByGame.set(gameId, new Map([[viewerId, existing]]));
}

export function listFantasyHighlights(gameId: string, viewerId: string): NotableEventRecord[] {
  return fantasyHighlightsByGame.get(gameId)?.get(viewerId) ?? [];
}

/** Finds the commentary line generated for a specific event — used to pair a backfilled fantasy play with its narration. */
export function getCommentaryForEvent(gameId: string, eventId: string): CommentaryLine | undefined {
  return listCommentary(gameId).find((c) => c.eventId === eventId);
}

// --- Live predictions ---------------------------------------------------------

export function addPrediction(prediction: Prediction): void {
  const existing = predictionsByGame.get(prediction.gameId) ?? [];
  existing.push(prediction);
  predictionsByGame.set(prediction.gameId, existing);
  predictionsById.set(prediction.id, prediction);
}

export function getPrediction(predictionId: string): Prediction | undefined {
  return predictionsById.get(predictionId);
}

/** Every prediction for a game, newest first. */
export function listPredictions(gameId: string): Prediction[] {
  return [...(predictionsByGame.get(gameId) ?? [])].reverse();
}

/** Every currently-open prediction for a game, in the order they were posed. */
export function listOpenPredictions(gameId: string): Prediction[] {
  return (predictionsByGame.get(gameId) ?? []).filter((p) => p.status === "open");
}

export function recordPredictionAnswer(answer: PredictionAnswer): void {
  let byViewer = answersByPrediction.get(answer.predictionId);
  if (!byViewer) {
    byViewer = new Map();
    answersByPrediction.set(answer.predictionId, byViewer);
  }
  byViewer.set(answer.viewerId, answer);
}

export function getPredictionAnswer(predictionId: string, viewerId: string): PredictionAnswer | undefined {
  return answersByPrediction.get(predictionId)?.get(viewerId);
}

/** Every answer submitted for a prediction — walked at resolution time to score each one. */
export function listPredictionAnswers(predictionId: string): PredictionAnswer[] {
  return [...(answersByPrediction.get(predictionId)?.values() ?? [])];
}

/** Folds one resolved prediction's outcome into a viewer's running accuracy. Never called for a voided prediction. */
export function bumpPredictionAccuracy(viewerId: string, correct: boolean): void {
  const current = predictionAccuracyByViewer.get(viewerId) ?? { correct: 0, total: 0 };
  current.total += 1;
  if (correct) current.correct += 1;
  predictionAccuracyByViewer.set(viewerId, current);
}

export function getPredictionAccuracy(viewerId: string): PredictionAccuracy {
  const rec = predictionAccuracyByViewer.get(viewerId) ?? { correct: 0, total: 0 };
  return { viewerId, correct: rec.correct, total: rec.total, accuracy: rec.total > 0 ? rec.correct / rec.total : 0 };
}

// --- Shared watch-party sessions ----------------------------------------------

/**
 * Idempotent on `(gameId, name)` (case-insensitive), same pattern as
 * `getOrCreateSubscription`: a second `POST /games/:id/parties` with the same
 * name returns the original party instead of creating a duplicate session.
 */
export function getOrCreateParty(gameId: string, name: string, create: () => WatchParty): { party: WatchParty; created: boolean } {
  let byName = partyIdByGameAndName.get(gameId);
  if (!byName) {
    byName = new Map();
    partyIdByGameAndName.set(gameId, byName);
  }
  const key = name.trim().toLowerCase();
  const existingId = byName.get(key);
  if (existingId) {
    return { party: partiesById.get(existingId)!, created: false };
  }
  const party = create();
  byName.set(key, party.id);
  partiesById.set(party.id, party);
  return { party, created: true };
}

export function getParty(partyId: string): WatchParty | undefined {
  return partiesById.get(partyId);
}

/** Adds a viewer to a party's member list, idempotent (joining twice is a no-op). */
export function addPartyMember(partyId: string, viewerId: string): WatchParty | undefined {
  const party = partiesById.get(partyId);
  if (!party) return undefined;
  if (!party.members.includes(viewerId)) {
    party.members.push(viewerId);
  }
  return party;
}

export function addPartyQnA(record: PartyQnA): void {
  const existing = qnaByParty.get(record.partyId) ?? [];
  existing.unshift(record); // newest first
  qnaByParty.set(record.partyId, existing);
}

/** A party's shared Q&A history, newest first. */
export function listPartyQnA(partyId: string): PartyQnA[] {
  return qnaByParty.get(partyId) ?? [];
}
