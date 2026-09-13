import type { Flashcard, StudySession } from "./types.js";
import { extractConceptsFromCard } from "./conceptGraph.js";

export interface StudyGuide {
  topic: string;
  sessionCount: number;
  cardCount: number;
  sessions: Array<{ id: string; title: string }>;
  combinedSummary: string;
  concepts: string[];
}

// TemplateFlashcardGenerator's summaries (flashcardGenerator.ts's `summarize`)
// all share this per-session boilerplate prefix — the sentence count and
// speaker count are meaningless once several sessions are merged into one
// guide, so it's stripped before merging rather than carried through N times.
const BOILERPLATE_PREFIX = /^Session covered \d+ statement\(s\)(?: across \d+ speaker\(s\))?\.\s*/;

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Lowercased, punctuation-stripped form used only to detect near-duplicate sentences across sessions. */
function normalizeSentenceKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merges N study sessions sharing a topic tag into one consolidated study
 * guide — a real union-of-material synthesis, not a raw concatenation of
 * their summaries:
 *
 *  - Each session's auto-generated summary has its per-session boilerplate
 *    prefix stripped, is split into sentences, and every sentence is
 *    deduplicated (by a normalized key) against every other session's —
 *    so two sessions that both happened to restate the same fact
 *    ("Mitochondria is the powerhouse of the cell.") contribute it to the
 *    guide once, not twice.
 *  - `concepts` is the union of every concept `extractConceptsFromCard`
 *    (conceptGraph.ts) resolves across every flashcard in every one of these
 *    sessions, deduplicated the same way the concept graph itself dedupes —
 *    so a student sees the full breadth of what's been covered on this
 *    topic without re-deriving it by hand from N separate session pages.
 *
 * Pure function: takes the sessions and their flashcards as plain data
 * rather than reading the store itself, so it's directly unit-testable (see
 * `buildTopicStudyGuide` in studyService.ts for the store-backed wrapper).
 */
export function buildStudyGuide(topic: string, sessions: StudySession[], cardsBySession: Map<string, Flashcard[]>): StudyGuide {
  const seenSentences = new Set<string>();
  const mergedSentences: string[] = [];
  for (const session of sessions) {
    const stripped = session.summary.replace(BOILERPLATE_PREFIX, "").trim();
    if (!stripped) continue;
    for (const sentence of splitIntoSentences(stripped)) {
      const key = normalizeSentenceKey(sentence);
      if (!key || seenSentences.has(key)) continue;
      seenSentences.add(key);
      mergedSentences.push(sentence);
    }
  }

  const seenConcepts = new Set<string>();
  const concepts: string[] = [];
  let cardCount = 0;
  for (const session of sessions) {
    const cards = cardsBySession.get(session.id) ?? [];
    cardCount += cards.length;
    for (const card of cards) {
      for (const concept of extractConceptsFromCard(card)) {
        if (seenConcepts.has(concept)) continue;
        seenConcepts.add(concept);
        concepts.push(concept);
      }
    }
  }
  concepts.sort();

  return {
    topic,
    sessionCount: sessions.length,
    cardCount,
    sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
    combinedSummary:
      mergedSentences.length > 0
        ? mergedSentences.join(" ")
        : `No summarizable content found across ${sessions.length} session(s) tagged "${topic}".`,
    concepts,
  };
}
