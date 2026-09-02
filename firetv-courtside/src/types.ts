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
}

export interface AskQuestionResult {
  question: string;
  answer: string;
  answeredAt: string;
}
