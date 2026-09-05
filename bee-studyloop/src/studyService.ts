import { randomUUID } from "node:crypto";
import type {
  Flashcard,
  PersonalFlashcardView,
  PersonalReviewState,
  Quiz,
  QuizAnswer,
  RawTranscript,
  RecallGrade,
  StudySession,
  TranscriptSegment,
} from "./types.js";
import type { FlashcardGenerator, GeneratedFlashcard } from "./flashcardGenerator.js";
import { generateClozeCards } from "./flashcardGenerator.js";
import { initialSchedulerState, isDue, scheduleReview } from "./scheduler.js";
import { initialLeechState, updateLeechState } from "./leech.js";
import { priorityScore } from "./priority.js";
import { extractTopics } from "./topics.js";
import { fromPortableTsv, toPortableTsv } from "./export.js";
import { initialStreakState, recordStreakDay, toStreakSummary, type StreakSummary } from "./streak.js";
import {
  getFlashcard,
  getQuiz,
  getReviewState,
  getSession as getSessionFromStore,
  getSessionIdForIdempotencyKey,
  getStreakState,
  listAllFlashcards,
  listFlashcardsBySession,
  listReviewStatesForStudent,
  saveFlashcard,
  saveQuiz,
  saveReviewState,
  saveSession,
  saveStreakState,
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
  /**
   * Marks this session as a shared study-group deck (see "Shared study-group
   * decks" in README.md): another student can pull its flashcards into their
   * own independent review queue via `POST /decks/:sessionId/join`. Defaults
   * to false — a session is private to whoever ingests it unless opted in.
   */
  shared?: boolean;
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
    shared: Boolean(input.shared),
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
  /**
   * Optional student context for the adaptive generation-bias heuristic (see
   * `computeWeakTopics` below and "Adaptive new-card generation bias" in
   * README.md). When omitted, weak topics are computed from the shared,
   * student-less flashcard pool (the same "default reviewer" every other
   * unscoped endpoint reads/writes) instead of one student's own history.
   */
  studentId?: string;
}

export interface AppendSegmentsResult {
  session: StudySession;
  newFlashcards: Flashcard[];
}

// Meaningfully below scheduler.ts's DEFAULT_EASE_FACTOR (2.5) — a topic
// whose cards average below this, or that has produced at least one leech,
// counts as a topic the student is struggling with. See computeWeakTopics.
const WEAK_TOPIC_EASE_THRESHOLD = 2.0;

// How many extra cloze cards the bias step may add for one append, so a
// single weak-topic append can't flood the session with dozens of trivial
// fill-in-the-blank cards.
const BIAS_EXTRA_CARD_CAP = 3;

/**
 * Topics (matching `Flashcard.tags`) a student has historically struggled
 * with, used only to bias *new* card generation in `appendSessionSegments`
 * — it never affects scheduling or review ordering. A topic counts as
 * "weak" if the average ease factor across every card carrying that tag
 * (for this student, if given, else across the shared default-reviewer
 * pool) is below `WEAK_TOPIC_EASE_THRESHOLD`, or if at least one card with
 * that tag is currently flagged a leech — either signal alone is enough,
 * since a single leech is a stronger red flag than a merely-below-average
 * ease factor (matching the same reasoning priority.ts uses).
 *
 * Limitation: a card carries the *session's* topics from whenever it was
 * generated, not a per-card re-classification, so a long multi-topic
 * session's cards all share the same tag set — a card that's actually about
 * topic B can still count toward topic A's average if they were tagged
 * together. Documented in FRICTION_LOG.md rather than solved with real
 * per-card topic modeling, which is out of scope for the heuristic tagger.
 */
function computeWeakTopics(studentId: string | undefined): Set<string> {
  const items: Array<{ tags: string[]; easeFactor: number; isLeech: boolean }> = studentId
    ? listReviewStatesForStudent(studentId)
        .map((state) => {
          const card = getFlashcard(state.cardId);
          return card ? { tags: card.tags, easeFactor: state.easeFactor, isLeech: state.isLeech } : undefined;
        })
        .filter((v): v is { tags: string[]; easeFactor: number; isLeech: boolean } => Boolean(v))
    : listAllFlashcards().map((c) => ({ tags: c.tags, easeFactor: c.easeFactor, isLeech: c.isLeech }));

  const stats = new Map<string, { easeSum: number; count: number; leeches: number }>();
  for (const item of items) {
    for (const tag of item.tags) {
      const s = stats.get(tag) ?? { easeSum: 0, count: 0, leeches: 0 };
      s.easeSum += item.easeFactor;
      s.count += 1;
      if (item.isLeech) s.leeches += 1;
      stats.set(tag, s);
    }
  }

  const weak = new Set<string>();
  for (const [tag, s] of stats) {
    if (s.leeches > 0 || s.easeSum / s.count < WEAK_TOPIC_EASE_THRESHOLD) weak.add(tag);
  }
  return weak;
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
 *
 * Adaptive generation bias (see README "Adaptive new-card generation bias"):
 * if the topics extracted from just the *newly appended* segments overlap
 * with `computeWeakTopics(input.studentId)`, a handful of extra simple
 * cloze-deletion cards are generated from those new segments alone — on top
 * of whatever the generator's normal Q&A/definition/cloze tiers already
 * produced for the full transcript — so a topic the student is struggling
 * with visibly yields more review material than one they're already acing.
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
  const newFronts = new Set(newCandidates.map((c) => c.front.trim().toLowerCase()));

  const weakTopics = computeWeakTopics(input.studentId);
  const appendedTopics = extractTopics(appended);
  const touchesWeakTopic = appendedTopics.some((t) => weakTopics.has(t));
  const biasCandidates: GeneratedFlashcard[] = touchesWeakTopic
    ? generateClozeCards(appended, BIAS_EXTRA_CARD_CAP).filter((c) => {
        const key = c.front.trim().toLowerCase();
        return !existingFronts.has(key) && !newFronts.has(key);
      })
    : [];

  const updatedSession: StudySession = { ...session, segments: updatedSegments, summary, topics };
  saveSession(updatedSession);

  const newFlashcards: Flashcard[] = [...newCandidates, ...biasCandidates].map((g) => ({
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
 * Sorts any pool of cards (real `Flashcard`s or per-student
 * `PersonalFlashcardView`s — both carry the same `dueAt`/`isLeech`/
 * `easeFactor` fields `priorityScore` reads) by the same adaptive priority
 * formula, descending. Shared by `listDueCards`, the per-student due/leech
 * queries, and quiz sampling, so "what order should a pool of cards be
 * reviewed in" is defined exactly once.
 */
function sortByPriority<T extends { dueAt: string; isLeech: boolean; easeFactor: number }>(cards: T[], now: Date): T[] {
  return [...cards].sort((a, b) => priorityScore(b, now) - priorityScore(a, now) || a.dueAt.localeCompare(b.dueAt));
}

/**
 * Flashcards due for review across every session, ordered by adaptive
 * priority (see `priority.ts`) rather than plain due-date order — an
 * overdue card, a leech, or a historically-hard (low ease) card surfaces
 * before a card that merely became due a moment ago.
 */
export function listDueCards(now: Date = new Date()): Flashcard[] {
  return sortByPriority(
    listAllFlashcards().filter((card) => isDue(card, now)),
    now
  );
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

// ===========================================================================
// Shared study-group decks
// ===========================================================================

/** Merges a flashcard's shared content with one student's own review state. */
function toPersonalView(
  card: Flashcard,
  studentId: string,
  state: Pick<PersonalReviewState, "interval" | "easeFactor" | "repetitions" | "dueAt" | "consecutiveFailures" | "isLeech" | "lastReviewedAt" | "lastGrade">
): PersonalFlashcardView {
  return {
    id: card.id,
    sessionId: card.sessionId,
    studentId,
    front: card.front,
    back: card.back,
    tags: card.tags,
    interval: state.interval,
    easeFactor: state.easeFactor,
    repetitions: state.repetitions,
    dueAt: state.dueAt,
    consecutiveFailures: state.consecutiveFailures,
    isLeech: state.isLeech,
    lastReviewedAt: state.lastReviewedAt,
    lastGrade: state.lastGrade,
  };
}

export type JoinDeckResult =
  | { ok: true; session: StudySession; cards: PersonalFlashcardView[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_shared" };

/**
 * Pulls a shared session's flashcards into one student's own review queue.
 * The flashcard *content* (front/back/tags) is never copied — only a fresh,
 * independent `PersonalReviewState` per card is created for this student
 * (skipped for a card they already have progress on, so re-joining is safe
 * and never resets existing progress). Two different students joining the
 * same session end up with two entirely separate sets of review state rows,
 * so their ease factors, due dates, and leech flags evolve independently
 * from each other and from the session's own embedded (student-less)
 * flashcard state, which is untouched by any of this.
 */
export function joinSharedDeck(sessionId: string, studentId: string, now: Date = new Date()): JoinDeckResult {
  const session = getSessionFromStore(sessionId);
  if (!session) return { ok: false, reason: "not_found" };
  if (!session.shared) return { ok: false, reason: "not_shared" };

  const cards = listFlashcardsBySession(sessionId).map((card) => {
    const existing = getReviewState(studentId, card.id);
    if (existing) return toPersonalView(card, studentId, existing);

    const fresh: PersonalReviewState = { studentId, cardId: card.id, ...initialSchedulerState(now), ...initialLeechState() };
    saveReviewState(fresh);
    return toPersonalView(card, studentId, fresh);
  });

  return { ok: true, session, cards };
}

/**
 * Records one student's own recall grade for a card — the `studentId`-aware
 * counterpart to `recordReview`. Reads/creates that student's own
 * `PersonalReviewState` (lazily initializing it if this is the first time
 * this student has touched this card, e.g. reviewing a joined card they
 * haven't explicitly joined-and-fetched yet) and reschedules only that
 * state, leaving the card's own embedded fields and every other student's
 * state on the same card completely untouched.
 */
export function recordReviewForStudent(studentId: string, cardId: string, grade: RecallGrade, now: Date = new Date()): PersonalFlashcardView | undefined {
  const card = getFlashcard(cardId);
  if (!card) return undefined;

  const existing: PersonalReviewState =
    getReviewState(studentId, cardId) ?? { studentId, cardId, ...initialSchedulerState(now), ...initialLeechState() };
  const nextState = scheduleReview(existing, grade, now);
  const leechState = updateLeechState(existing, grade);
  const updated: PersonalReviewState = {
    ...existing,
    ...nextState,
    ...leechState,
    lastReviewedAt: now.toISOString(),
    lastGrade: grade,
  };
  saveReviewState(updated);
  recordStreakActivity(studentId, now);
  return toPersonalView(card, studentId, updated);
}

// ===========================================================================
// Study streaks & gamification
// ===========================================================================

/**
 * Folds a just-completed review into a student's streak state (see
 * streak.ts for what counts as a "streak day" and how milestones work).
 * Called from `recordReviewForStudent` — a "completed review" is one graded
 * against a named student, so the shared, student-less "default reviewer"
 * path (`recordReview`, no `studentId`) intentionally never touches streaks;
 * there's no single student to credit.
 */
function recordStreakActivity(studentId: string, now: Date): void {
  const current = getStreakState(studentId) ?? initialStreakState(studentId);
  saveStreakState(recordStreakDay(current, now));
}

/**
 * Current/longest streak length and earned badges for one student. A
 * student who hasn't completed a review yet gets a valid, all-zero summary
 * rather than a 404 — asking about a streak that hasn't started yet isn't an
 * error.
 */
export function getStreakForStudent(studentId: string): StreakSummary {
  const state = getStreakState(studentId) ?? initialStreakState(studentId);
  return toStreakSummary(state);
}

function personalViewsForStudent(studentId: string): PersonalFlashcardView[] {
  return listReviewStatesForStudent(studentId)
    .map((state) => {
      const card = getFlashcard(state.cardId);
      return card ? toPersonalView(card, studentId, state) : undefined;
    })
    .filter((v): v is PersonalFlashcardView => Boolean(v));
}

/** A student's own due cards (joined decks + any card they've directly reviewed), adaptively ordered. */
export function listDueCardsForStudent(studentId: string, now: Date = new Date()): PersonalFlashcardView[] {
  return sortByPriority(
    personalViewsForStudent(studentId).filter((v) => isDue(v, now)),
    now
  );
}

/** A student's own cards currently flagged as leeches, worst streak first. */
export function listLeechCardsForStudent(studentId: string): PersonalFlashcardView[] {
  return personalViewsForStudent(studentId)
    .filter((v) => v.isLeech)
    .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.dueAt.localeCompare(b.dueAt));
}

// ===========================================================================
// Quiz / practice-test mode
// ===========================================================================

function sampleQuizPool(studentId: string | undefined): Array<Flashcard | PersonalFlashcardView> {
  return studentId ? personalViewsForStudent(studentId) : listAllFlashcards();
}

/**
 * Samples up to `count` cards into a new timed quiz. Reuses the exact same
 * due-filtering (`isDue`) and priority-ranking (`sortByPriority`/
 * `priorityScore`) logic `GET /review/due` is built on, rather than
 * duplicating it: due cards are pulled first (worst-priority — leeches and
 * overdue/hard cards — first), then, if `count` isn't filled yet, padded out
 * with not-yet-due cards in the same priority order. When `studentId` is
 * given, the pool is that student's own personal deck (joined + directly
 * reviewed cards); otherwise it's the shared, student-less flashcard pool
 * every other unscoped endpoint reads.
 */
export function startQuiz(count: number, studentId: string | undefined, now: Date = new Date()): Quiz {
  const pool = sampleQuizPool(studentId);
  const due = sortByPriority(
    pool.filter((c) => isDue(c, now)),
    now
  );
  const notDue = sortByPriority(
    pool.filter((c) => !isDue(c, now)),
    now
  );
  const cardIds = [...due, ...notDue].slice(0, Math.max(0, Math.floor(count))).map((c) => c.id);

  const quiz: Quiz = { id: randomUUID(), studentId, cardIds, startedAt: now.toISOString(), answers: {} };
  saveQuiz(quiz);
  return quiz;
}

/** The question-only view of a quiz's sampled cards — `back` is withheld until it's graded. */
export function getQuizPrompts(quiz: Quiz): Array<{ cardId: string; front: string }> {
  return quiz.cardIds.map((cardId) => ({ cardId, front: getFlashcard(cardId)?.front ?? "" }));
}

export type SubmitQuizAnswerResult =
  | { ok: true; correct: boolean }
  | { ok: false; reason: "quiz_not_found" }
  | { ok: false; reason: "card_not_in_quiz" };

/**
 * Grades one quiz answer. Grading heuristic: the submitted answer is
 * trimmed, lowercased, and whitespace-collapsed, then compared for exact
 * equality against the card's `back` text processed the same way — a simple
 * case-insensitive/trimmed match, not fuzzy or partial-credit grading. See
 * FRICTION_LOG.md for why (and its tradeoffs against something looser).
 * Re-answering the same card overwrites its previous grade rather than
 * accumulating attempts.
 */
export function submitQuizAnswer(quizId: string, cardId: string, answer: string, now: Date = new Date()): SubmitQuizAnswerResult {
  const quiz = getQuiz(quizId);
  if (!quiz) return { ok: false, reason: "quiz_not_found" };
  if (!quiz.cardIds.includes(cardId)) return { ok: false, reason: "card_not_in_quiz" };

  const card = getFlashcard(cardId);
  const correct = Boolean(card) && normalizeForGrading(answer) === normalizeForGrading(card!.back);
  const answerRecord: QuizAnswer = { cardId, submittedAnswer: answer, correct, answeredAt: now.toISOString() };
  const updatedQuiz: Quiz = { ...quiz, answers: { ...quiz.answers, [cardId]: answerRecord } };
  saveQuiz(updatedQuiz);

  return { ok: true, correct };
}

function normalizeForGrading(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface QuizResults {
  id: string;
  studentId?: string;
  total: number;
  answered: number;
  correct: number;
  complete: boolean;
  missed: Array<{ cardId: string; front: string; back: string; submittedAnswer: string }>;
}

/** Score summary for a quiz, computable at any point — mid-quiz (partial) or once every card has been answered. */
export function getQuizResults(quizId: string): QuizResults | undefined {
  const quiz = getQuiz(quizId);
  if (!quiz) return undefined;

  const answers = Object.values(quiz.answers);
  const missed = answers
    .filter((a) => !a.correct)
    .map((a) => {
      const card = getFlashcard(a.cardId);
      return { cardId: a.cardId, front: card?.front ?? "", back: card?.back ?? "", submittedAnswer: a.submittedAnswer };
    });

  return {
    id: quiz.id,
    studentId: quiz.studentId,
    total: quiz.cardIds.length,
    answered: answers.length,
    correct: answers.length - missed.length,
    complete: answers.length >= quiz.cardIds.length,
    missed,
  };
}

// ===========================================================================
// Due-card reminder digest
// ===========================================================================

export interface ReminderDigest {
  studentId: string;
  summary: string;
  counts: {
    due: number; // due right now
    dueLeeches: number; // of those due, how many are leeches
    totalLeeches: number; // every leech this student has, due or not
    totalCards: number; // every card in this student's personal deck
  };
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function buildDigestSummary(dueCount: number, dueLeechCount: number, totalLeeches: number): string {
  if (dueCount === 0) {
    if (totalLeeches > 0) {
      return `You have no cards due right now, but you still have ${totalLeeches} leech${totalLeeches === 1 ? "" : "es"} worth revisiting when you get a chance.`;
    }
    return "You have no cards due right now. Nice work staying on top of your reviews!";
  }
  const leechClause = dueLeechCount > 0 ? `, including ${dueLeechCount} leech${dueLeechCount === 1 ? "" : "es"}` : "";
  return `You have ${pluralize(dueCount, "card")} due today${leechClause}.`;
}

/**
 * A compact, read-aloud-friendly due-card summary for one student, e.g.
 * "You have 5 cards due today, including 2 leeches." Built from the exact
 * same per-student due/leech logic `GET /review/due?studentId=` and
 * `GET /review/leeches?studentId=` use, so the digest can never drift out of
 * sync with what the student would actually see in their queue.
 */
export function getReminderDigest(studentId: string, now: Date = new Date()): ReminderDigest {
  const due = listDueCardsForStudent(studentId, now);
  const totalLeeches = listLeechCardsForStudent(studentId).length;
  const dueLeeches = due.filter((c) => c.isLeech).length;
  const totalCards = listReviewStatesForStudent(studentId).length;

  return {
    studentId,
    summary: buildDigestSummary(due.length, dueLeeches, totalLeeches),
    counts: { due: due.length, dueLeeches, totalLeeches, totalCards },
  };
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

// ===========================================================================
// Global daily review session planner
// ===========================================================================

export interface ReviewSession {
  studentId: string;
  maxCards: number;
  totalDue: number; // how many cards are due across every deck, before capping
  cards: PersonalFlashcardView[];
}

/**
 * Builds one bounded "here's your review for today" session for a student,
 * across *every* deck they have — their own directly-reviewed cards and
 * every shared deck they've joined (see `personalViewsForStudent`, the same
 * pool `GET /review/due?studentId=` reads) — capped at `maxCards` and kept in
 * the existing adaptive priority order (`sortByPriority`/`priorityScore`), so
 * a leech or badly-overdue card from one deck still outranks a merely-due
 * card from another rather than decks being interleaved round-robin or
 * concatenated deck-by-deck. This is deliberately just a bounded slice of
 * `listDueCardsForStudent`, not a new ranking algorithm: the "session
 * planner" is the cap and the "how many did we leave for later" count
 * (`totalDue`), not a different ordering.
 */
export function buildReviewSession(studentId: string, maxCards: number, now: Date = new Date()): ReviewSession {
  const due = listDueCardsForStudent(studentId, now);
  const cap = Math.max(0, Math.floor(maxCards));
  return { studentId, maxCards: cap, totalDue: due.length, cards: due.slice(0, cap) };
}

// ===========================================================================
// Import round-trip (the inverse of GET /export)
// ===========================================================================

export interface ImportFlashcardsInput {
  /** The exact TSV format `toPortableTsv`/`GET /export` produces (header optional — see `fromPortableTsv`). */
  tsv: string;
  /**
   * Import into an existing session, deduplicating against the cards it
   * already has. Omit to create a fresh session to hold the imported cards
   * (nothing to dedupe against but the batch itself) — the natural shape for
   * "restore a full backup" rather than "merge into a deck I'm still using."
   */
  sessionId?: string;
  /** Title for the session created when `sessionId` is omitted. */
  title?: string;
}

export type ImportFlashcardsResult =
  | { ok: true; session: StudySession; imported: Flashcard[]; skippedDuplicates: number }
  | { ok: false; reason: "session_not_found" };

/**
 * Creates flashcards from a TSV export, so a student can back up their deck
 * and restore it later, or migrate cards between environments (e.g. a local
 * dev instance and a deployed one). Deduplicates by trimmed, lowercased
 * `front` text — the same key `appendSessionSegments` already uses to avoid
 * re-minting cards for material it's seen before — against two pools at
 * once: whatever the target session already has (so re-importing the same
 * export twice, or importing into a session you already exported from, is a
 * safe no-op for cards that already exist) and whatever this same import
 * batch has already added (so a TSV with an accidental duplicate row doesn't
 * create two identical cards). Every imported card starts with fresh
 * scheduling/leech state (`initialSchedulerState`/`initialLeechState`) since
 * a TSV export carries no review history — only front/back/tags survive a
 * round trip, by design (see FRICTION_LOG.md).
 */
export function importFlashcards(input: ImportFlashcardsInput, now: Date = new Date()): ImportFlashcardsResult {
  const rows = fromPortableTsv(input.tsv);

  let session: StudySession;
  if (input.sessionId) {
    const existing = getSessionFromStore(input.sessionId);
    if (!existing) return { ok: false, reason: "session_not_found" };
    session = existing;
  } else {
    session = {
      id: randomUUID(),
      title: input.title?.trim() || `Imported deck — ${now.toLocaleDateString("en-US")}`,
      createdAt: now.toISOString(),
      segments: [],
      summary: `Imported from a TSV export (${rows.length} row(s)).`,
      topics: [],
      shared: false,
    };
    saveSession(session);
  }

  const existingFronts = new Set(listFlashcardsBySession(session.id).map((c) => c.front.trim().toLowerCase()));
  const seenInBatch = new Set<string>();
  const imported: Flashcard[] = [];
  let skippedDuplicates = 0;

  for (const row of rows) {
    const key = row.front.trim().toLowerCase();
    if (existingFronts.has(key) || seenInBatch.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    seenInBatch.add(key);

    const card: Flashcard = {
      id: randomUUID(),
      sessionId: session.id,
      front: row.front,
      back: row.back,
      createdAt: now.toISOString(),
      tags: row.tags,
      ...initialSchedulerState(now),
      ...initialLeechState(),
    };
    saveFlashcard(card);
    imported.push(card);
  }

  return { ok: true, session, imported, skippedDuplicates };
}

// ===========================================================================
// Regenerate-a-card
// ===========================================================================

/**
 * Best-effort recovery of the specific transcript material a given card was
 * generated from, so `regenerateFlashcard` can re-run generation over just
 * that material rather than the whole session (which would just reproduce
 * the same card set the original ingest already did). Exploits how each of
 * `TemplateFlashcardGenerator`'s three tiers builds a card's `front`/`back`,
 * checked in the same tier order the generator itself uses:
 *
 *  1. Q&A cards carry the two source segments' text *verbatim* as front/back
 *     (see tier 1 in flashcardGenerator.ts) — so an exact match against two
 *     adjacent segments recovers them exactly.
 *  2. Cloze cards' front is `"Fill in the blank: " + <sentence with the
 *     target word replaced by "____">` — substituting the card's own `back`
 *     (the blanked word) back into the blank reconstructs the original
 *     sentence, which is then located in the transcript by substring match.
 *  3. Definition cards' front is a reformatted `"What is <Term>?"` rather
 *     than verbatim source text, so there's no exact reconstruction; falling
 *     back to "the segment mentioning the term" is the closest available
 *     signal.
 *
 * Falls back to the session's *entire* transcript if none of the above finds
 * anything more specific — regeneration still produces a result, just
 * without the "just this card's material" narrowing. Documented as a
 * heuristic, not a guarantee, in FRICTION_LOG.md: a hand-typed transcript
 * with unusual phrasing can still fall through to the whole-transcript case.
 */
function findUnderlyingSegments(session: StudySession, card: Flashcard): TranscriptSegment[] {
  const segments = session.segments;

  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].text.trim() === card.front && segments[i + 1].text.trim() === card.back) {
      return [segments[i], segments[i + 1]];
    }
  }

  const clozeMatch = /^Fill in the blank: (.*)$/.exec(card.front);
  if (clozeMatch) {
    const reconstructed = clozeMatch[1].replace("____", card.back);
    const exact = segments.find((s) => s.text.includes(reconstructed));
    if (exact) return [exact];
    const byAnswerWord = segments.find((s) => s.text.toLowerCase().includes(card.back.toLowerCase()));
    if (byAnswerWord) return [byAnswerWord];
  }

  const defMatch = /^What is (.+)\?$/.exec(card.front);
  if (defMatch) {
    const term = defMatch[1].toLowerCase();
    const byTerm = segments.find((s) => s.text.toLowerCase().includes(term));
    if (byTerm) return [byTerm];
  }

  return segments;
}

export type RegenerateCardResult =
  | { ok: true; card: Flashcard }
  | { ok: false; reason: "card_not_found" }
  | { ok: false; reason: "session_not_found" }
  | { ok: false; reason: "no_alternative" };

/**
 * Re-runs flashcard generation against just one card's underlying transcript
 * material (see `findUnderlyingSegments`) to produce an alternative
 * phrasing, replacing that card's `front`/`back` in place. Everything else —
 * `id`, `tags`, scheduling state (`interval`/`easeFactor`/`repetitions`/
 * `dueAt`), and leech state (`consecutiveFailures`/`isLeech`) — is carried
 * over untouched, so regenerating a card doesn't reset a student's progress
 * on it.
 *
 * Reuses the injected `FlashcardGenerator` — the exact same generator
 * `ingestSession`/`appendSessionSegments` already call — rather than
 * duplicating any pattern-matching logic: the primary path is just
 * `generator.generate(underlyingSegments)`, filtered to a candidate whose
 * `front` differs from the card's current one. Realistically this alone
 * finds something in a lot of cases (e.g. a Q&A pair's two segments will
 * often also match the definition-pattern tier, yielding a genuinely
 * different question/answer pair for the same material — see the smoke
 * test). Only when the generator's normal tiers produce nothing different
 * does this fall back to `generateClozeCards` directly on the same
 * underlying material for a guaranteed-different fill-in-the-blank
 * phrasing — reusing that exported helper (already used elsewhere for the
 * adaptive generation-bias feature) rather than writing a second cloze
 * generator here.
 */
export async function regenerateFlashcard(generator: FlashcardGenerator, cardId: string): Promise<RegenerateCardResult> {
  const card = getFlashcard(cardId);
  if (!card) return { ok: false, reason: "card_not_found" };
  const session = getSessionFromStore(card.sessionId);
  if (!session) return { ok: false, reason: "session_not_found" };

  const underlying = findUnderlyingSegments(session, card);
  const currentKey = card.front.trim().toLowerCase();

  const { flashcards: candidates } = await generator.generate(underlying);
  let alternative = candidates.find((c) => c.front.trim().toLowerCase() !== currentKey);

  if (!alternative) {
    alternative = generateClozeCards(underlying, 5).find((c) => c.front.trim().toLowerCase() !== currentKey);
  }

  if (!alternative) return { ok: false, reason: "no_alternative" };

  const updated: Flashcard = { ...card, front: alternative.front, back: alternative.back };
  saveFlashcard(updated);
  return { ok: true, card: updated };
}
