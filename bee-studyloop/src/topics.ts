import type { TranscriptSegment } from "./types.js";

// Deliberately small: common words plus the question words already
// special-cased in flashcardGenerator.ts, so they never crowd out an
// actual content word as a "topic."
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "for", "and", "or", "but", "if", "so",
  "because", "this", "that", "these", "those", "it", "its", "what", "who",
  "when", "where", "why", "how", "which", "whose", "whom", "do", "does",
  "did", "not", "no", "yes", "you", "your", "we", "they", "he", "she",
  "with", "as", "by", "from", "about", "into", "than", "then", "also",
  "can", "could", "will", "would", "should", "just", "like", "kind",
  "sort", "basically", "actually", "there", "here", "have", "has", "had",
]);

/**
 * Heuristic topic-tag extraction — explicitly NOT real NLP/topic modeling
 * (see README "Advanced features"). Scores each content word (length >= 4,
 * not a stopword) by how often it appears, with a small bonus for words that
 * showed up capitalized in the original text (a cheap proxy for proper
 * nouns / key terms — "Mitochondria," "Osmosis"), and returns the top `max`
 * as lowercase tags. Good enough to cluster sessions/flashcards that share
 * vocabulary; nothing more sophisticated than word frequency.
 */
export function extractTopics(segments: TranscriptSegment[], max = 3): string[] {
  const fullText = segments.map((s) => s.text).join(" ");
  const rawWords = fullText.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];

  const freq = new Map<string, number>();
  const seenCapitalized = new Set<string>();

  for (const raw of rawWords) {
    const lower = raw.toLowerCase();
    if (lower.length < 4 || STOPWORDS.has(lower)) continue;
    if (/^[A-Z]/.test(raw)) seenCapitalized.add(lower);
    freq.set(lower, (freq.get(lower) ?? 0) + 1);
  }

  const scored = [...freq.entries()].map(([word, count]) => ({
    word,
    score: count + (seenCapitalized.has(word) ? 1.5 : 0),
  }));

  scored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
  return scored.slice(0, max).map((s) => s.word);
}
