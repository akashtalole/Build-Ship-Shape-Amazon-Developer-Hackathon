export type Team = "home" | "away";

export type GameStatus = "in_progress" | "final";

/**
 * The play-by-play event vocabulary this service understands. Stands in for
 * whatever a computer-vision pipeline or a sports data API (e.g. a
 * play-by-play webhook) would emit in production.
 */
export type EventType =
  | "score"
  | "foul"
  | "turnover"
  | "rebound"
  | "steal"
  | "block"
  | "timeout"
  | "period_end"
  | "game_end";

export const VALID_EVENT_TYPES: readonly EventType[] = [
  "score",
  "foul",
  "turnover",
  "rebound",
  "steal",
  "block",
  "timeout",
  "period_end",
  "game_end",
];

/** What a computer-vision pipeline / data feed POSTs to `/games/:id/events`. */
export interface IncomingGameEvent {
  type: EventType;
  team?: Team;
  player?: string;
  points?: number; // required for "score" events
  description?: string; // free-text detail, e.g. "reaching-in foul" or "traveling"
  period?: number; // if the feed reports the current period alongside the play
  clock?: string; // if the feed reports the game clock alongside the play, e.g. "8:42"
  /**
   * Optional idempotency key from the upstream feed (its own event/play ID).
   * Re-posting the same `externalEventId` for the same game is a no-op: no
   * duplicate commentary, no duplicate state mutation. Protects against a
   * flaky CV pipeline or webhook double-posting the same play.
   */
  externalEventId?: string;
}

export interface GameEvent extends IncomingGameEvent {
  id: string;
  gameId: string;
  occurredAt: string; // ISO timestamp
}

export interface StartGameInput {
  sport?: string; // e.g. "basketball" (default) — kept generic so other sports fit the same model
  homeTeam: string;
  awayTeam: string;
  periodLabel?: string; // e.g. "quarter" (default), "period", "half"
  initialClock?: string; // default "12:00"
}

export interface GameState {
  id: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: number;
  periodLabel: string;
  clock: string;
  status: GameStatus;
  /** Most recent events, newest first, capped to a fixed length. */
  recentEvents: GameEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CommentaryLine {
  id: string;
  gameId: string;
  text: string;
  eventId?: string; // the GameEvent this line narrates, if any (absent for Q&A-style lines)
  createdAt: string;
}

export interface AskQuestionInput {
  question: string;
  /** Optional viewer ID: enables per-viewer rate limiting and answer personalization. */
  viewerId?: string;
}

export interface AskQuestionResult {
  question: string;
  answer: string;
  answeredAt: string;
}

/**
 * Per-viewer commentary preferences (`POST /games/:id/viewers/:viewerId/preferences`).
 * Applied at read time on top of the shared, generated commentary/answers —
 * see `personalizeText` in `commentaryProvider.ts`.
 */
export interface ViewerPreferences {
  /** Team name (or "home"/"away") this viewer is rooting for; adds a fan-perspective note when it matches a team in the game. */
  favoriteTeam?: string;
  /** "concise" (default behavior, no change) or "detailed" (appends period/clock/score context). */
  verbosity?: "concise" | "detailed";
}

/** Per-game counters for the fast-path/escalated commentary split. See `GET /games/:id/metrics`. */
export interface GameMetrics {
  fastPathCount: number;
  escalatedCount: number;
}
