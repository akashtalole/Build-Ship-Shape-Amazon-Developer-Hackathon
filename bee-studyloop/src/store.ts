import type { Flashcard, StudySession } from "./types.js";

const sessions = new Map<string, StudySession>();
const flashcards = new Map<string, Flashcard>();
const cardIdsBySession = new Map<string, string[]>();

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
