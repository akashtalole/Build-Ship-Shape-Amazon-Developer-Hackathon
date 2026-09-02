import { randomUUID } from "node:crypto";
import type { Flashcard, RawTranscript, RecallGrade, StudySession, TranscriptSegment } from "./types.js";
import type { FlashcardGenerator } from "./flashcardGenerator.js";
import { initialSchedulerState, isDue, scheduleReview } from "./scheduler.js";
import { initialLeechState, updateLeechState } from "./leech.js";
import { priorityScore } from "./priority.js";
import { extractTopics } from "./topics.js";
import { toPortableTsv } from "./export.js";
import {
  getFlashcard,
  getSession as getSessionFromStore,
  getSessionIdForIdempotencyKey,
  listAllFlashcards,
  listFlashcardsBySession,
  saveFlashcard,
  saveSession,
  setIdempotencyKey,
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
  /**
   * Optional caller-supplied dedupe key (e.g. a client-generated UUID, or
   * Bee's own session id). Re-ingesting with the same key returns the
   * *original* session/flashcards instead of generating duplicates — this
   * is what makes a retried upload (flaky network, an at-least-once queue,
   * a doubled-click on a "sync now" button) safe to replay.
   */
  idempotencyKey?: string;
}

export interface IngestResult {
  session: StudySession;
  flashcards: Flashcard[];
}

export async function ingestSession(generator: FlashcardGenerator, input: IngestSessionInput): Promise<IngestResult> {
  // Idempotent replay: if this key was already used, hand back the exact
  // session/flashcards created the first time rather than regenerating.
  if (input.idempotencyKey) {
    const existingId = getSessionIdForIdempotencyKey(input.idempotencyKey);
    if (existingId) {
      const existing = getSessionWithCards(existingId);
      if (existing) return { session: existing.session, flashcards: existing.flashcards };
    }
  }

  const segments = normalizeTranscript(input.transcript);
  const now = new Date();
  const { summary, flashcards: generated } = await generator.generate(segments);
  const topics = extractTopics(segments);

  const session: StudySession = {
    id: randomUUID(),
    title: input.title?.trim() || `Study session — ${now.toLocaleDateString("en-US")}`,
    createdAt: now.toISOString(),
    segments,
    summary,
    topics,
    idempotencyKey: input.idempotencyKey,
  };
  saveSession(session);
  if (input.idempotencyKey) setIdempotencyKey(input.idempotencyKey, session.id);

  const cards: Flashcard[] = generated.map((g) => ({
    id: randomUUID(),
    sessionId: session.id,
    front: g.front,
    back: g.back,
    createdAt: now.toISOString(),
    tags: topics,
    ...initialSchedulerState(now),
    ...initialLeechState(),
  }));
  cards.forEach(saveFlashcard);

  return { session, flashcards: cards };
}

export interface AppendSegmentsInput {
  segments: RawTranscript;
}

export interface AppendSegmentsResult {
  session: StudySession;
  newFlashcards: Flashcard[];
}

/**
 * Incremental ingestion for a session that's still "open" — mirroring Bee's
 * continuous ambient capture (many small appends over the course of a
 * session) rather than one big batch upload after the fact.
 *
 * Regenerates the summary/topics from the *full* updated transcript (so they
 * reflect everything captured so far, old + new), but only saves flashcards
 * whose `front` doesn't already match an existing card for this session —
 * that dedupe is what stops re-running the generator over the whole
 * transcript from re-minting duplicate cards for material it already
 * produced a card from on a previous ingest/append. See FRICTION_LOG.md for
 * the tradeoff this approach makes (full-transcript regeneration is simple
 * and correctly catches Q&A/definitions that span the old/new boundary, at
 * the cost of the generator's own "no cards yet -> fall back to cloze"
 * heuristic only ever firing once per session).
 */
export async function appendSessionSegments(
  generator: FlashcardGenerator,
  sessionId: string,
  input: AppendSegmentsInput,
  now: Date = new Date()
): Promise<AppendSegmentsResult | undefined> {
  const session = getSessionFromStore(sessionId);
  if (!session) return undefined;

  const appended = normalizeTranscript(input.segments);
  const updatedSegments = [...session.segments, ...appended];

  const { summary, flashcards: candidates } = await generator.generate(updatedSegments);
  const topics = extractTopics(updatedSegments);

  const existingFronts = new Set(listFlashcardsBySession(sessionId).map((c) => c.front.trim().toLowerCase()));
  const newCandidates = candidates.filter((c) => !existingFronts.has(c.front.trim().toLowerCase()));

  const updatedSession: StudySession = { ...session, segments: updatedSegments, summary, topics };
  saveSession(updatedSession);

  const newFlashcards: Flashcard[] = newCandidates.map((g) => ({
    id: randomUUID(),
    sessionId,
    front: g.front,
    back: g.back,
    createdAt: now.toISOString(),
    tags: topics,
    ...initialSchedulerState(now),
    ...initialLeechState(),
  }));
  newFlashcards.forEach(saveFlashcard);

  return { session: updatedSession, newFlashcards };
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

/**
 * Flashcards due for review across every session, ordered by adaptive
 * priority (see `priority.ts`) rather than plain due-date order — an
 * overdue card, a leech, or a historically-hard (low ease) card surfaces
 * before a card that merely became due a moment ago.
 */
export function listDueCards(now: Date = new Date()): Flashcard[] {
  return listAllFlashcards()
    .filter((card) => isDue(card, now))
    .sort((a, b) => priorityScore(b, now) - priorityScore(a, now) || a.dueAt.localeCompare(b.dueAt));
}

/** Cards currently flagged as leeches, across every session, worst streak first. */
export function listLeechCards(): Flashcard[] {
  return listAllFlashcards()
    .filter((card) => card.isLeech)
    .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.dueAt.localeCompare(b.dueAt));
}

/** Flashcards across every session whose tags include the given topic (case-insensitive). */
export function searchFlashcardsByTopic(topic: string): Flashcard[] {
  const needle = topic.trim().toLowerCase();
  if (!needle) return [];
  return listAllFlashcards().filter((card) => card.tags.some((t) => t.toLowerCase() === needle));
}

export function recordReview(cardId: string, grade: RecallGrade, now: Date = new Date()): Flashcard | undefined {
  const card = getFlashcard(cardId);
  if (!card) return undefined;

  const nextState = scheduleReview(card, grade, now);
  const leechState = updateLeechState(card, grade);
  const updated: Flashcard = {
    ...card,
    ...nextState,
    ...leechState,
    lastReviewedAt: now.toISOString(),
    lastGrade: grade,
  };
  saveFlashcard(updated);
  return updated;
}

/** Portable TSV export of every flashcard in a single session. Undefined if the session doesn't exist. */
export function exportSessionFlashcards(sessionId: string): string | undefined {
  const session = getSessionFromStore(sessionId);
  if (!session) return undefined;
  return toPortableTsv(listFlashcardsBySession(sessionId));
}

/** Portable TSV export of every flashcard across every session. */
export function exportAllFlashcards(): string {
  return toPortableTsv(listAllFlashcards());
}
