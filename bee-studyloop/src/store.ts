import type { Flashcard, PersonalReviewState, Quiz, StudySession } from "./types.js";

const sessions = new Map<string, StudySession>();
const flashcards = new Map<string, Flashcard>();
const cardIdsBySession = new Map<string, string[]>();
const sessionIdByIdempotencyKey = new Map<string, string>();

// Per-student review state (see PersonalReviewState in types.ts), keyed by
// `${studentId}\0${cardId}` so two students' progress on the same shared
// card never collide. `reviewStateIdsByStudent` tracks which card ids each
// student has a state for, so "list this student's personal deck" doesn't
// require scanning every review state ever recorded.
const reviewStates = new Map<string, PersonalReviewState>();
const reviewStateCardIdsByStudent = new Map<string, Set<string>>();

const quizzes = new Map<string, Quiz>();

function reviewStateKey(studentId: string, cardId: string): string {
  return `${studentId}\0${cardId}`;
}

export function saveSession(session: StudySession): void {
  sessions.set(session.id, session);
}

export function getSession(id: string): StudySession | undefined {
  return sessions.get(id);
}

export function listSessions(): StudySession[] {
  return [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveFlashcard(card: Flashcard): void {
  flashcards.set(card.id, card);
  const existing = cardIdsBySession.get(card.sessionId);
  if (existing) {
    if (!existing.includes(card.id)) existing.push(card.id);
  } else {
    cardIdsBySession.set(card.sessionId, [card.id]);
  }
}

export function getFlashcard(id: string): Flashcard | undefined {
  return flashcards.get(id);
}

export function listFlashcardsBySession(sessionId: string): Flashcard[] {
  const ids = cardIdsBySession.get(sessionId) ?? [];
  return ids.map((id) => flashcards.get(id)).filter((c): c is Flashcard => Boolean(c));
}

export function listAllFlashcards(): Flashcard[] {
  return [...flashcards.values()];
}

/** Looks up a previously ingested session by the caller-supplied idempotency key, if any. */
export function getSessionIdForIdempotencyKey(key: string): string | undefined {
  return sessionIdByIdempotencyKey.get(key);
}

/** Records which session a given idempotency key resolved to, for future retries. */
export function setIdempotencyKey(key: string, sessionId: string): void {
  sessionIdByIdempotencyKey.set(key, sessionId);
}

/** A specific student's review progress on a specific card, if they have any yet. */
export function getReviewState(studentId: string, cardId: string): PersonalReviewState | undefined {
  return reviewStates.get(reviewStateKey(studentId, cardId));
}

export function saveReviewState(state: PersonalReviewState): void {
  reviewStates.set(reviewStateKey(state.studentId, state.cardId), state);
  const existing = reviewStateCardIdsByStudent.get(state.studentId);
  if (existing) existing.add(state.cardId);
  else reviewStateCardIdsByStudent.set(state.studentId, new Set([state.cardId]));
}

/** Every card a given student has their own review progress on (joined decks + directly-reviewed cards). */
export function listReviewStatesForStudent(studentId: string): PersonalReviewState[] {
  const cardIds = reviewStateCardIdsByStudent.get(studentId);
  if (!cardIds) return [];
  return [...cardIds]
    .map((cardId) => reviewStates.get(reviewStateKey(studentId, cardId)))
    .filter((s): s is PersonalReviewState => Boolean(s));
}

export function saveQuiz(quiz: Quiz): void {
  quizzes.set(quiz.id, quiz);
}

export function getQuiz(id: string): Quiz | undefined {
  return quizzes.get(id);
}
