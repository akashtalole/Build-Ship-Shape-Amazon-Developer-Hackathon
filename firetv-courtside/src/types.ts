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
  /** Which commentary-generation path produced this line (see `isNotableEvent`) — used to regenerate the same line in a different locale via the correct provider (`TemplateCommentaryProvider` for "fast", the configured `CommentaryProvider` for "escalated"). Absent for a line predating this field. */
  path?: "fast" | "escalated";
}

export interface AskQuestionInput {
  question: string;
  /** Optional viewer ID: enables per-viewer rate limiting and answer personalization. */
  viewerId?: string;
  /** Optional watch-party ID (see `WatchParty`): when given, this question+answer is shared with every party member instead of staying private to the asker. Requires `viewerId`. */
  partyId?: string;
  /** Optional commentary locale/style for this one answer (see `CommentaryLocale`) — overrides the viewer's stored preference, if any. */
  locale?: CommentaryLocale;
}

export interface AskQuestionResult {
  question: string;
  answer: string;
  answeredAt: string;
  /** Echoed back when the question was shared into a watch party. */
  partyId?: string;
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
  /** Default commentary locale/style for this viewer (see `CommentaryLocale`) — used by `GET /games/:id/commentary` and `POST /games/:id/ask` when no explicit `?locale=`/`locale` is given for a request that does carry this viewerId. */
  locale?: CommentaryLocale;
}

/** Per-game counters for the fast-path/escalated commentary split. See `GET /games/:id/metrics`. */
export interface GameMetrics {
  fastPathCount: number;
  escalatedCount: number;
}

/**
 * A notable event paired with the commentary generated for it — the unit
 * both `GET /games/:id/highlights` and `GET /watchlist` are built from. See
 * `isNotableEvent` in gameService.ts for what qualifies. Stored uncapped
 * (unlike `GameState.recentEvents`, which is capped for the live overlay),
 * since a highlight reel needs the whole game's notable moments, not just
 * the last few.
 */
export interface NotableEventRecord {
  event: GameEvent;
  commentary: CommentaryLine;
}

/**
 * A webhook registration for `POST /games/:id/subscriptions`: notifies
 * `callbackUrl` with a signed payload whenever a notable event happens in
 * `gameId`. `secret` is generated server-side and returned once in the
 * registration response — the receiver uses it to verify the
 * `X-CourtSide-Signature` header on each delivery (see README).
 */
export interface Subscription {
  id: string;
  gameId: string;
  callbackUrl: string;
  /** Optional viewer this subscription is registered on behalf of. Purely informational — does not affect delivery. */
  viewerId?: string;
  /**
   * Optional player filter: when set, only a notable event whose `player`
   * field matches this name (case-insensitively) triggers a delivery to this
   * subscription — everything else about the game is ignored. Absent means
   * "every notable event in the game," the original round-3 behavior.
   */
  playerName?: string;
  secret: string;
  createdAt: string;
}

/**
 * Cumulative stats for one team or player, aggregated across every game
 * ingested this process has seen (not just one game) — see
 * `GET /stats/team/:teamName` and `GET /stats/player/:playerName`.
 * `eventCounts` is keyed by the same `EventType` vocabulary used for
 * ingestion, so it automatically covers whatever event types a sport uses.
 */
export interface EntityStats {
  name: string;
  /** Number of distinct games this team/player has had at least one event recorded in. */
  gamesPlayed: number;
  /** Sum of `points` across every "score" event attributed to this team/player. */
  points: number;
  eventCounts: Partial<Record<EventType, number>>;
  /** How many of this team/player's events were notable (see `isNotableEvent`). */
  notableEvents: number;
}

// --- Round 5: fantasy-relevant plays, predictions, watch parties, locales ----

/**
 * A viewer's fantasy roster for one game (`POST /games/:id/fantasy/:viewerId`)
 * — the small set of player names they drafted. Purely a lens on the existing
 * event stream: any ingested event naming one of these players (via the
 * existing `IncomingGameEvent.player` field — no new event vocabulary needed)
 * gets tagged into that viewer's fantasy highlight reel, retrievable
 * separately from the shared commentary feed via
 * `GET /games/:id/fantasy/:viewerId`.
 */
export interface FantasyRosterResult {
  gameId: string;
  viewerId: string;
  /** Trimmed player names as registered, display casing preserved. */
  roster: string[];
}

export interface FantasyHighlightsResult extends FantasyRosterResult {
  /** Notable-to-this-viewer plays naming a rostered player, newest first. Includes plays before registration (backfilled) and after (appended live). */
  highlights: NotableEventRecord[];
}

/** The two prediction shapes CourtSide can pose — see `posePrediction` in gameService.ts for how each is generated and resolved from real game events. */
export type PredictionType = "next_possession_score" | "next_team_to_score";

export type PredictionStatus = "open" | "resolved" | "voided";

/**
 * A live prediction posed against real game state (`POST /games/:id/predictions`).
 * Stays `"open"` until a subsequent ingested event actually resolves it (see
 * `resolveOpenPredictions` in gameService.ts) — never a canned, pre-scored
 * question. `"voided"` covers a prediction still open when the game ends:
 * there's no further event that could ever resolve it, so it's retired
 * without counting against or for anyone's accuracy.
 */
export interface Prediction {
  id: string;
  gameId: string;
  type: PredictionType;
  question: string;
  /** Valid answer values for this prediction — e.g. `["yes", "no"]` or `["home", "away"]`. */
  options: string[];
  status: PredictionStatus;
  createdAt: string;
  resolvedAt?: string;
  /** The event that actually resolved this prediction (absent while `"open"` or if `"voided"`). */
  resolvedEventId?: string;
  /** The real outcome, one of `options` (absent while `"open"` or if `"voided"`). */
  outcome?: string;
}

/** One viewer's answer to a prediction, submitted before the outcome is known. */
export interface PredictionAnswer {
  predictionId: string;
  viewerId: string;
  answer: string;
  submittedAt: string;
  /** Set once the prediction resolves (or voids, where it stays undefined — a voided prediction was never scored). */
  correct?: boolean;
}

/** A viewer's running prediction accuracy across every prediction they've answered that has since resolved. */
export interface PredictionAccuracy {
  viewerId: string;
  correct: number;
  total: number;
  /** `correct / total`, or 0 when `total` is 0 — never NaN. */
  accuracy: number;
}

/**
 * A shared watch-party session for a game (`POST /games/:id/parties`):
 * viewers join a named session together, and questions asked with a
 * `partyId` (see `AskQuestionInput.partyId`) become visible to every member
 * instead of staying private to the asker. Idempotent on `(gameId, name)` —
 * see `getOrCreateParty` in store.ts.
 */
export interface WatchParty {
  id: string;
  gameId: string;
  name: string;
  /** viewerIds currently in the party. */
  members: string[];
  createdAt: string;
}

/**
 * A question+answer shared into a watch party — recorded so
 * `GET /games/:id/parties/:partyId/qa` has a durable history, and also
 * pushed live over `GET /games/:id/stream` (tagged `type: "party_qa"`) the
 * instant it's asked, same delivery path `NotableEventRecord` commentary uses.
 */
export interface PartyQnA {
  id: string;
  gameId: string;
  partyId: string;
  viewerId: string;
  question: string;
  answer: string;
  askedAt: string;
}

/**
 * The commentary locales/styles `CommentaryProvider` genuinely supports —
 * distinct phrasing conventions, not a translated swap of the same English
 * templates. `"en-broadcast"` is the original round 1-4 wording (the
 * default, byte-for-byte unchanged when no locale is requested);
 * `"en-casual"` is a casual, friend-watching-with-you voice; `"es-broadcast"`
 * is a formal Spanish-language broadcast voice. See "Localized commentary
 * packs" in `commentaryProvider.ts`.
 */
export type CommentaryLocale = "en-broadcast" | "en-casual" | "es-broadcast";

export const VALID_LOCALES: readonly CommentaryLocale[] = ["en-broadcast", "en-casual", "es-broadcast"];

export const DEFAULT_LOCALE: CommentaryLocale = "en-broadcast";
