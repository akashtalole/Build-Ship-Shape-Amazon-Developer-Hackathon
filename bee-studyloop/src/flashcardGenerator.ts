import type { TranscriptSegment } from "./types.js";

export interface GeneratedFlashcard {
  front: string;
  back: string;
}

export interface GenerationResult {
  summary: string;
  flashcards: GeneratedFlashcard[];
}

/**
 * The LLM-shaped seam: takes a normalized transcript and returns a summary
 * plus a set of flashcards. `TemplateFlashcardGenerator` below implements
 * this with no model at all (pure heuristics), so the whole pipeline runs
 * offline and deterministically. A real deployment swaps in an
 * `LlmFlashcardGenerator` that sends the same segments to a model (e.g.
 * Amazon Bedrock) with a prompt like "extract key facts and Q&A pairs from
 * this study session transcript as JSON {summary, flashcards[]}" and parses
 * the response into this same shape — nothing in `studyService.ts` or
 * `server.ts` needs to change.
 */
export interface FlashcardGenerator {
  generate(segments: TranscriptSegment[]): GenerationResult | Promise<GenerationResult>;
}

const QUESTION_WORDS = new Set(["what", "who", "when", "where", "why", "how", "which", "whose", "whom"]);

// Matches simple definitional statements: "<Term> is/are/means/refers to <definition>."
// Anchored to the whole (trimmed) sentence so it doesn't fire on sub-clauses.
const DEFINITION_PATTERN = /^([A-Z][A-Za-z0-9 ,'-]{1,60}?)\s+(?:is|are|means|refers to)\s+([^.?!]{3,160})[.?!]?$/;

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function stripLeadingArticle(term: string): string {
  return term.replace(/^(the|a|an)\s+/i, "").trim();
}

function ensureTerminalPunctuation(s: string): string {
  return /[.?!]$/.test(s) ? s : `${s}.`;
}

/**
 * Cloze-deletion card generation, factored out of `TemplateFlashcardGenerator`
 * so it can be called two ways: as tier 3's fallback (only when the other two
 * tiers found nothing at all, over the *whole* transcript), and directly by
 * `appendSessionSegments` in studyService.ts as part of the adaptive
 * generation-bias heuristic (see README "Adaptive new-card generation bias")
 * — deliberately run over just the newly-appended segments, and deliberately
 * NOT gated on "no other cards exist yet," so it can add a few simple extra
 * cards for a weak topic even when the session already has plenty of cards
 * overall. Blanks the longest word in each sufficiently-long sentence, on
 * the theory that a longer word is more likely to be the sentence's key term
 * than a short connective.
 */
export function generateClozeCards(segments: TranscriptSegment[], maxCount = 5): GeneratedFlashcard[] {
  const fullText = segments.map((s) => s.text).join(" ");
  const candidates = splitIntoSentences(fullText).filter((s) => s.split(/\s+/).length >= 5);

  const cards: GeneratedFlashcard[] = [];
  const seenFronts = new Set<string>();
  for (const sentence of candidates) {
    if (cards.length >= maxCount) break;
    const words = sentence.replace(/[.?!]$/, "").split(/\s+/);
    const target = [...words].sort((a, b) => b.length - a.length)[0];
    if (!target || target.length < 4) continue;
    const blanked = sentence.replace(target, "____");
    const front = `Fill in the blank: ${blanked}`;
    const key = front.trim().toLowerCase();
    if (seenFronts.has(key)) continue;
    seenFronts.add(key);
    cards.push({ front, back: target.replace(/[.,;:]$/, "") });
  }
  return cards;
}

/**
 * Template/heuristic flashcard generator — no LLM required. It looks for
 * three progressively looser patterns in a study transcript:
 *
 *  1. Question/answer exchanges: a segment ending in "?" immediately
 *     followed by a non-question segment (someone asked, someone answered).
 *  2. Definition-style statements: "<Term> is/are/means/refers to <X>."
 *  3. Fallback cloze cards from the longest remaining sentences, so even a
 *     transcript with no obvious Q&A or definitions still yields some
 *     review material (and an empty transcript degrades to zero cards
 *     instead of throwing).
 */
export class TemplateFlashcardGenerator implements FlashcardGenerator {
  generate(segments: TranscriptSegment[]): GenerationResult {
    if (segments.length === 0) {
      return { summary: "No substantial content was captured in this session.", flashcards: [] };
    }

    const cards: GeneratedFlashcard[] = [];
    const seenFronts = new Set<string>();

    const addCard = (rawFront: string, rawBack: string) => {
      const front = rawFront.trim();
      const back = rawBack.trim();
      const key = front.toLowerCase();
      if (!front || !back || seenFronts.has(key)) return;
      seenFronts.add(key);
      cards.push({ front, back });
    };

    // 1. Question/answer exchanges.
    for (let i = 0; i < segments.length - 1; i++) {
      const question = segments[i].text.trim();
      const answer = segments[i + 1].text.trim();
      if (question.endsWith("?") && answer.length > 0 && !answer.endsWith("?")) {
        addCard(question, answer);
      }
    }

    // 2. Definition-style statements, scanned sentence-by-sentence so the
    //    anchored regex doesn't need to reason about sentence boundaries.
    const fullText = segments.map((s) => s.text).join(" ");
    const statementSentences = splitIntoSentences(fullText).filter((s) => !s.endsWith("?"));
    for (const sentence of statementSentences) {
      const match = DEFINITION_PATTERN.exec(sentence);
      if (!match) continue;
      const term = stripLeadingArticle(match[1]);
      if (!term || QUESTION_WORDS.has(term.toLowerCase())) continue;
      const definition = ensureTerminalPunctuation(capitalize(match[2].trim()));
      addCard(`What is ${capitalize(term)}?`, definition);
    }

    // 3. Fallback: cloze-deletion cards built from the longest sentences.
    if (cards.length === 0) {
      for (const c of generateClozeCards(segments, 5)) addCard(c.front, c.back);
    }

    return { summary: summarize(segments), flashcards: cards.slice(0, 12) };
  }
}

function summarize(segments: TranscriptSegment[]): string {
  const fullText = segments.map((s) => s.text).join(" ");
  const sentences = splitIntoSentences(fullText);
  const speakers = new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)));

  const highlights = sentences
    .filter((s) => !s.endsWith("?"))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const body = (highlights.length > 0 ? highlights : sentences.slice(0, 3)).join(" ");

  const speakerNote = speakers.size > 0 ? ` across ${speakers.size} speaker(s)` : "";
  return `Session covered ${sentences.length} statement(s)${speakerNote}. ${body}`.trim();
}
