import type { RecallGrade } from "./types.js";
import { STOPWORDS } from "./topics.js";

/** Fraction of an answer's key terms an explanation must cover to "pass." Matches the `good`/`hard` boundary in `scoreToRecallGrade`. */
const PASS_THRESHOLD = 0.5;

/**
 * A light heuristic stemmer — strip common plural/verb endings so
 * "photosynthesizes"/"photosynthesizing" still credits a card whose answer
 * says "photosynthesis," without needing exact string equality. Genuinely
 * checks for the underlying word, not a guarantee of correct stemming (see
 * FRICTION_LOG.md) — good enough for short flashcard-answer vocabulary.
 */
function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.length > 6 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

function tokenize(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
}

/**
 * The set of "key terms" a correct explanation of this answer ought to
 * mention: significant content words (length >= 4, not a stopword). Falls
 * back to every word >= 3 characters if the answer is too short/plain to
 * have any (e.g. a one-word answer like "Paris") so a valid answer never
 * yields zero checkable terms.
 */
function keyTerms(answer: string): string[] {
  const words = tokenize(answer).map((w) => w.toLowerCase());
  const significant = words.filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const pool = significant.length > 0 ? significant : words.filter((w) => w.length >= 3);
  return [...new Set(pool)];
}

export interface ExplanationGrade {
  /** Fraction (0-1) of the answer's key terms the explanation covered. */
  score: number;
  matchedTerms: string[];
  missingTerms: string[];
  passed: boolean;
}

/**
 * Grades a free-text explanation against a flashcard's actual `back` content
 * — the real rubric behind the Feynman/peer-teaching "explain it to learn
 * it" mode. No LLM dependency: it extracts the answer's key terms and checks
 * how many the explanation mentions (after light stemming on both sides, so
 * "cells" credits "cell" and vice versa), then reports exactly which terms
 * were covered and which were missing so the feedback is genuinely
 * actionable rather than a bare pass/fail. This is a heuristic keyword
 * rubric, not real semantic understanding — a student who paraphrases every
 * key idea with zero shared vocabulary ("the little power factories" for
 * "mitochondria produces energy") would score poorly despite being roughly
 * right, a real and documented limitation of going LLM-free (see
 * FRICTION_LOG.md) — but it genuinely rewards restating the substance in
 * different words/order, not exact string equality.
 */
export function gradeExplanation(answer: string, explanation: string): ExplanationGrade {
  const terms = keyTerms(answer);
  if (terms.length === 0) {
    // Nothing checkable about this answer (e.g. empty/symbol-only back) —
    // don't penalize the student for something the card itself can't rubric.
    return { score: 1, matchedTerms: [], missingTerms: [], passed: true };
  }

  const explanationStems = new Set(tokenize(explanation).map(stem));
  const matchedTerms: string[] = [];
  const missingTerms: string[] = [];
  for (const term of terms) {
    if (explanationStems.has(stem(term))) matchedTerms.push(term);
    else missingTerms.push(term);
  }

  const score = matchedTerms.length / terms.length;
  return { score, matchedTerms, missingTerms, passed: score >= PASS_THRESHOLD };
}

/**
 * Maps a graded explanation's key-term coverage onto the same four-point
 * recall vocabulary `POST /review/:cardId` uses, so submitting an
 * explanation reschedules the card through the exact same SM-2/leech
 * machinery a normal grade would (see `submitExplanation` in
 * studyService.ts) rather than a parallel, disconnected scoring path.
 */
export function scoreToRecallGrade(score: number): RecallGrade {
  if (score >= 0.85) return "easy";
  if (score >= PASS_THRESHOLD) return "good";
  if (score >= 0.25) return "hard";
  return "again";
}

/** A plain-language feedback sentence built from a graded explanation's coverage. */
export function buildExplanationFeedback(grade: ExplanationGrade): string {
  if (grade.missingTerms.length === 0) {
    return grade.matchedTerms.length > 0
      ? `Nice work — your explanation covers the key idea${grade.matchedTerms.length === 1 ? "" : "s"}: ${grade.matchedTerms.join(", ")}.`
      : "Nice work — that covers it.";
  }
  if (grade.matchedTerms.length === 0) {
    return `Your explanation didn't mention the key idea${grade.missingTerms.length === 1 ? "" : "s"}: ${grade.missingTerms.join(", ")}. Review the card's answer and try explaining it again in your own words.`;
  }
  return `Good start — you covered ${grade.matchedTerms.join(", ")}, but missed mentioning ${grade.missingTerms.join(", ")}.`;
}
