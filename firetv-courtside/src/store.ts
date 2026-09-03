import type {
  CommentaryLine,
  GameEvent,
  GameMetrics,
  GameState,
  NotableEventRecord,
  Subscription,
  ViewerPreferences,
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

/** Outbound score-alert subscriptions, keyed by gameId -> callbackUrl (the idempotency key). */
const subscriptionsByGame = new Map<string, Map<string, Subscription>>();

/** Every gameId a viewer has interacted with (asked a question on, or set preferences for) — powers `GET /watchlist`. */
const gamesByViewer = new Map<string, Set<string>>();

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

/**
 * Registers a subscription, idempotent on (gameId, callbackUrl): a second
 * registration of the same callback for the same game returns the original
 * subscription (same id, same secret) instead of creating a duplicate.
 * `create` is only invoked when no existing subscription matches.
 */
export function getOrCreateSubscription(
  gameId: string,
  callbackUrl: string,
  create: () => Subscription
): { subscription: Subscription; created: boolean } {
  let byCallbackUrl = subscriptionsByGame.get(gameId);
  if (!byCallbackUrl) {
    byCallbackUrl = new Map();
    subscriptionsByGame.set(gameId, byCallbackUrl);
  }
  const existing = byCallbackUrl.get(callbackUrl);
  if (existing) {
    return { subscription: existing, created: false };
  }
  const subscription = create();
  byCallbackUrl.set(callbackUrl, subscription);
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
