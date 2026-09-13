import type { Flashcard } from "./types.js";
import { STOPWORDS } from "./topics.js";

// Question words that show up as leading tokens/high-frequency filler in a
// card's own front/back text but should never themselves be picked as "the
// concept" — a superset of topics.ts's own filtering, scoped to what leaks
// through when scanning a single short card instead of a whole transcript.
const QUESTION_WORDS = new Set(["what", "who", "when", "where", "why", "how", "which", "whose", "whom", "does", "do", "did", "is", "are"]);

// Definition-style fronts, matching both flashcardGenerator.ts's tier-2
// "What is <Term>?" cards AND tier-1 Q&A cards whose source question
// happened to start with "What is/are" — either way, the phrase after
// "What is/are" is the concept the card is actually about.
const WHAT_IS_PATTERN = /^what\s+(?:is|are)\s+(.+?)\??$/i;

// flashcardGenerator.ts's cloze-card front format: "Fill in the blank: <sentence with ____>".
const CLOZE_PATTERN = /^fill in the blank:/i;

function stripLeadingArticle(term: string): string {
  return term.replace(/^(the|a|an)\s+/i, "").trim();
}

/** Case/whitespace/punctuation-insensitive normal form for a concept string. */
export function normalizeConcept(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.?!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function significantWords(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? []).map((w) => w.toLowerCase());
}

/**
 * Extracts 1-2 lightweight "concept" identifiers from a single flashcard's
 * own front/back content — pure text analysis, no manual tagging system for
 * a caller to populate. Three tiers, cheapest/most-specific first:
 *
 *  1. Definition-style fronts ("What is/are <X>?") — this matches BOTH
 *     flashcardGenerator.ts's tier-2 definition cards and any tier-1 Q&A
 *     card whose source question happened to be phrased that way — yield the
 *     defined term/noun phrase itself as the concept (e.g. "mitochondria",
 *     or "the powerhouse of the cell" for a Q&A pair phrased as a question
 *     about that phrase).
 *  2. Cloze cards ("Fill in the blank: ...") yield the blanked word/phrase —
 *     the card's own `back` — as the concept.
 *  3. Any other card (a generic Q&A pair not phrased as "what is") yields
 *     the highest-scoring significant content word(s) shared across its
 *     front and back text, using the same word-frequency +
 *     capitalization-bonus heuristic topics.ts uses for a whole transcript,
 *     just scoped to one card's own two fields — the word the exchange was
 *     actually about tends to appear in both the question and the answer.
 *
 * This is what makes `GET /concepts/:name` a real graph rather than a manual
 * tagging lookup: two cards from entirely different study sessions, ingested
 * weeks apart, that both happen to define or reference the same term resolve
 * to the same concept string here with no link ever having been created by
 * hand.
 */
export function extractConceptsFromCard(card: Pick<Flashcard, "front" | "back">): string[] {
  const front = card.front.trim();
  const back = card.back.trim();

  const whatIs = WHAT_IS_PATTERN.exec(front);
  if (whatIs) {
    const term = normalizeConcept(stripLeadingArticle(whatIs[1]));
    if (term) return [term];
  }

  if (CLOZE_PATTERN.test(front)) {
    const term = normalizeConcept(back);
    if (term) return [term];
  }

  const capitalized = new Set((`${front} ${back}`.match(/\b[A-Z][a-z'-]{2,}/g) ?? []).map((w) => w.toLowerCase()));
  const freq = new Map<string, number>();
  for (const w of [...significantWords(front), ...significantWords(back)]) {
    if (w.length < 4 || STOPWORDS.has(w) || QUESTION_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  if (freq.size === 0) return [];

  const scored = [...freq.entries()].map(([word, count]) => ({
    word,
    score: count + (capitalized.has(word) ? 1.5 : 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
  return scored.slice(0, 2).map((s) => s.word);
}

/** Whether two concept strings refer to the same concept, ignoring case/whitespace/trailing punctuation. */
export function conceptsMatch(a: string, b: string): boolean {
  return normalizeConcept(a) === normalizeConcept(b);
}
