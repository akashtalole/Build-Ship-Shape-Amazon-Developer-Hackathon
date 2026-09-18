/**
 * Auto-tag suggestion: a simple keyword heuristic that guesses a sensible
 * tag for a note's text when the caller didn't pass one explicitly.
 *
 * This is deliberately dumb (no NLP, no scoring, no stemming) — it's meant
 * to save a little typing on the common case, not to be a classifier. Each
 * rule is a fixed list of keywords/phrases; the first rule with a match
 * wins (rules are checked in the order below, so "friction" beats
 * "worked-well" beats "feature-request" when a note happens to contain
 * words from more than one list — an edge case rare enough not to be worth
 * a smarter tie-break). A single-word keyword is matched on a word
 * boundary (so "fail" doesn't match inside "failsafe"... it actually does,
 * see the boundary note below); a multi-word phrase is matched as a plain
 * substring. Returns `undefined` when nothing matches, so callers fall back
 * to whatever their normal default-tag logic already does.
 */

export interface AutoTagRule {
  tag: string;
  /** Lowercase keywords/phrases. Single words are matched on a `\b` word boundary; phrases (containing a space) as a plain substring. */
  keywords: string[];
}

export const AUTO_TAG_RULES: AutoTagRule[] = [
  {
    tag: "friction",
    keywords: [
      "bug",
      "broke",
      "broken",
      "breaks",
      "error",
      "errors",
      "errored",
      "crash",
      "crashed",
      "crashes",
      "fail",
      "failed",
      "failing",
      "confusing",
      "confused",
      "stuck",
    ],
  },
  {
    tag: "worked-well",
    keywords: ["worked", "works", "nice", "clean", "smooth", "smoothly", "great", "easy", "painless"],
  },
  {
    tag: "feature-request",
    keywords: ["should", "would be nice", "wish", "wished", "could use", "want"],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Suggests a tag for `note`'s free text, or `undefined` if no rule's
 * keywords appear anywhere in it. Case-insensitive.
 */
export function suggestTag(note: string): string | undefined {
  const lower = note.toLowerCase();
  for (const rule of AUTO_TAG_RULES) {
    for (const keyword of rule.keywords) {
      const pattern = keyword.includes(" ") ? escapeRegExp(keyword) : `\\b${escapeRegExp(keyword)}\\b`;
      if (new RegExp(pattern).test(lower)) {
        return rule.tag;
      }
    }
  }
  return undefined;
}
