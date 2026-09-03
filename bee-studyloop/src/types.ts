/**
 * A single utterance from a study session's ambient transcript. This is the
 * shape a real Bee MCP server/CLI call (e.g. a `get_transcript` tool for a
 * given session or time range) already returns — diarized, timestamped
 * segments — so it doubles as the seam between StudyLoop's ingestion layer
 * and Bee itself. See `normalizeTranscript` in `studyService.ts`.
 */
export interface TranscriptSegment {
  speaker?: string;
  text: string;
  timestampMs?: number;
}

/**
 * What `POST /sessions` accepts: either a raw block of text (a lecture
 * recording transcribed as one blob, or a quick paste) or an array of
 * pre-segmented utterances. Both are normalized to `TranscriptSegment[]`
 * before generation.
 */
export type RawTranscript = string | TranscriptSegment[];

export interface StudySession {
  id: string;
  title: string;
  createdAt: string; // ISO timestamp
  segments: TranscriptSegment[];
  summary: string;

  // Heuristic topic tags extracted from the transcript (see topics.ts) —
  // simple keyword frequency, NOT real NLP/topic modeling. Recomputed over
  // the full transcript on ingest and on every incremental append.
  topics: string[];

  // Caller-supplied dedupe key for idempotent `POST /sessions` retries (see
  // `ingestSession` in studyService.ts). Undefined when the caller didn't
  // send one.
  idempotencyKey?: string;

  // Set at ingestion time (`POST /sessions { shared: true }`). When true,
  // another student can pull this session's flashcards into their own
  // review queue via `POST /decks/:sessionId/join` — see "Shared study-group
  // decks" in README.md.
  shared: boolean;
}

/** A simplified four-point recall grade, in place of raw SM-2's 0-5 scale. */
export type RecallGrade = "again" | "hard" | "good" | "easy";

export interface Flashcard {
  id: string;
  sessionId: string;
  front: string;
  back: string;
  createdAt: string; // ISO timestamp

  // Inherited from the parent session's `topics` at the moment this card was
  // generated (initial ingest or a later incremental append) — see
  // `GET /flashcards/search?topic=`.
  tags: string[];

  // Spaced-repetition scheduling state (see scheduler.ts).
  interval: number; // days until the next review
  easeFactor: number; // SM-2 "E-Factor", how quickly the interval grows
  repetitions: number; // consecutive successful (quality >= 3) reviews
  dueAt: string; // ISO timestamp; card is due when dueAt <= now

  lastReviewedAt?: string; // ISO timestamp
  lastGrade?: RecallGrade;

  // Leech-detection state (see leech.ts). A card becomes a leech after
  // enough consecutive failing grades in a row; a single good/easy grade
  // clears it.
  consecutiveFailures: number;
  isLeech: boolean;
}

/**
 * Per-student spaced-repetition progress on a *shared* flashcard (see
 * "Shared study-group decks" in README.md). The flashcard's own `front`/
 * `back`/`tags` content lives once on the `Flashcard` record itself and is
 * never copied; only the review state — the exact fields a card would
 * otherwise carry directly (interval, easeFactor, repetitions, dueAt,
 * leech tracking) — is tracked per (studentId, cardId) pair, independent of
 * both the card's own embedded state (used when no `studentId` is given —
 * see `recordReview`/`listDueCards` in studyService.ts) and of every other
 * student's progress on that same card. Created lazily: on
 * `POST /decks/:sessionId/join`, or the first time a `studentId`-tagged
 * review is submitted for a card, whichever happens first.
 */
export interface PersonalReviewState {
  studentId: string;
  cardId: string;
  interval: number;
  easeFactor: number;
  repetitions: number;
  dueAt: string;
  consecutiveFailures: number;
  isLeech: boolean;
  lastReviewedAt?: string;
  lastGrade?: RecallGrade;
}

/**
 * A flashcard as seen by one specific student: the shared `front`/`back`/
 * `tags` content merged with that student's own `PersonalReviewState`. This
 * is the shape returned by deck-join, student-scoped due/leech queries, and
 * student-scoped quiz sampling.
 */
export interface PersonalFlashcardView {
  id: string; // == the underlying Flashcard's id
  sessionId: string;
  studentId: string;
  front: string;
  back: string;
  tags: string[];
  interval: number;
  easeFactor: number;
  repetitions: number;
  dueAt: string;
  consecutiveFailures: number;
  isLeech: boolean;
  lastReviewedAt?: string;
  lastGrade?: RecallGrade;
}

/** One graded answer within a quiz — see "Quiz/practice-test mode" in README.md. */
export interface QuizAnswer {
  cardId: string;
  submittedAnswer: string;
  correct: boolean;
  answeredAt: string; // ISO timestamp
}

/**
 * A timed practice-test session: a fixed, sampled set of flashcard ids
 * (`cardIds`, in presentation order) plus whatever answers have been
 * submitted so far (keyed by cardId — re-answering a card overwrites its
 * previous grade rather than accumulating attempts). See `startQuiz`,
 * `submitQuizAnswer`, and `getQuizResults` in studyService.ts.
 */
export interface Quiz {
  id: string;
  studentId?: string;
  cardIds: string[];
  startedAt: string; // ISO timestamp
  answers: Record<string, QuizAnswer>;
}
