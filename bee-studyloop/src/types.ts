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
