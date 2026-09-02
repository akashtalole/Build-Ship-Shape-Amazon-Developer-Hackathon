import { randomUUID } from "node:crypto";
import type { Flashcard, RawTranscript, RecallGrade, StudySession, TranscriptSegment } from "./types.js";
import type { FlashcardGenerator } from "./flashcardGenerator.js";
import { initialSchedulerState, isDue, scheduleReview } from "./scheduler.js";
import {
  getFlashcard,
  getSession as getSessionFromStore,
  listAllFlashcards,
  listFlashcardsBySession,
  saveFlashcard,
  saveSession,
} from "./store.js";

/**
 * The ingestion seam. In this hackathon build, callers hand StudyLoop a raw
 * transcript directly (`POST /sessions`), standing in for what Bee's real
 * MCP server/CLI would provide. In production, this function's input would
 * instead come from calling Bee's transcript-retrieval MCP tool (e.g.
 * `get_transcript` for a session or time range) — which already returns
 * diarized, timestamped segments in this exact `TranscriptSegment` shape —
 * so the array branch below *is* the real integration path, and only the
 * string branch (a convenience for pasting raw text by hand) would become
 * unnecessary once Bee is wired in directly.
 */
export function normalizeTranscript(raw: RawTranscript): TranscriptSegment[] {
  if (Array.isArray(raw)) {
    return raw.filter((s): s is TranscriptSegment => Boolean(s) && typeof s.text === "string" && s.text.trim().length > 0);
  }

  const text = (raw ?? "").trim();
  if (!text) return [];

  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.?!])\s+/))
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ text: t }));
}

export interface IngestSessionInput {
  title?: string;
  transcript: RawTranscript;
}

export interface IngestResult {
  session: StudySession;
  flashcards: Flashcard[];
}

export async function ingestSession(generator: FlashcardGenerator, input: IngestSessionInput): Promise<IngestResult> {
  const segments = normalizeTranscript(input.transcript);
  const now = new Date();
  const { summary, flashcards: generated } = await generator.generate(segments);

  const session: StudySession = {
    id: randomUUID(),
    title: input.title?.trim() || `Study session — ${now.toLocaleDateString("en-US")}`,
    createdAt: now.toISOString(),
    segments,
    summary,
  };
  saveSession(session);

  const cards: Flashcard[] = generated.map((g) => ({
    id: randomUUID(),
    sessionId: session.id,
    front: g.front,
    back: g.back,
    createdAt: now.toISOString(),
    ...initialSchedulerState(now),
  }));
  cards.forEach(saveFlashcard);

  return { session, flashcards: cards };
}

export interface SessionWithCards {
  session: StudySession;
  flashcards: Flashcard[];
}

export function getSessionWithCards(id: string): SessionWithCards | undefined {
  const session = getSessionFromStore(id);
  if (!session) return undefined;
  return { session, flashcards: listFlashcardsBySession(id) };
}

/** Flashcards due for review across every session, soonest-due first. */
export function listDueCards(now: Date = new Date()): Flashcard[] {
  return listAllFlashcards()
    .filter((card) => isDue(card, now))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export function recordReview(cardId: string, grade: RecallGrade, now: Date = new Date()): Flashcard | undefined {
  const card = getFlashcard(cardId);
  if (!card) return undefined;

  const nextState = scheduleReview(card, grade, now);
  const updated: Flashcard = {
    ...card,
    ...nextState,
    lastReviewedAt: now.toISOString(),
    lastGrade: grade,
  };
  saveFlashcard(updated);
  return updated;
}
