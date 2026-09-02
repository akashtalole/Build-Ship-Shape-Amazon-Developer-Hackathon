import type { CommentaryLine, GameEvent, GameMetrics, GameState, ViewerPreferences } from "./types.js";

const MAX_RECENT_EVENTS = 15;

const games = new Map<string, GameState>();
const commentaryByGame = new Map<string, CommentaryLine[]>(); // newest first

/** Idempotency ledger for `externalEventId`: gameId -> externalEventId -> the original ingest's event+commentary. */
const externalEventsByGame = new Map<string, Map<string, { event: GameEvent; commentary: CommentaryLine }>>();

/** Fast-path vs escalated commentary-generation counters, per game. */
const metricsByGame = new Map<string, GameMetrics>();

/** Per-viewer preferences, keyed by gameId -> viewerId. */
const preferencesByGame = new Map<string, Map<string, ViewerPreferences>>();

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
