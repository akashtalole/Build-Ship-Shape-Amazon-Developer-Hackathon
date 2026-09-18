import type { LogEntry } from "./types.js";

/**
 * Severity/impact scoring for `friction-log top` — a deliberately simple,
 * fully explainable heuristic (no ML, no network calls) that estimates how
 * much a given entry actually matters for "what goes in the submission's
 * friction log," so the highest-value entries surface first at deadline time
 * instead of requiring someone to reread the whole log by hand.
 *
 * The score is the sum of three independently-explainable components, each
 * of which contributes its own line to `reasons` (in the order below) so the
 * ranking is never a black box:
 *
 *   1. Tag weight — a `friction` entry is worth far more than a
 *      `worked-well` one (which isn't a problem at all), since severity is
 *      fundamentally about "how much did this get in the way."
 *   2. Keyword weight — the note's own wording: strong blocker/crash/
 *      dead-end language adds points, "minor"/"cosmetic"/"nit"-style
 *      hedging subtracts them. Same word-boundary matching style as
 *      `autotag.ts`'s `suggestTag`, just with weighted rules instead of a
 *      single tag guess.
 *   3. Recency weight — a more recent entry (relative to the *other entries
 *      being scored*, so this is a relative rank, not an absolute clock)
 *      scores slightly higher, since a problem still unresolved near a
 *      hackathon deadline usually matters more for the submission than one
 *      resolved on day one.
 */

export interface SeverityBreakdown {
  entry: LogEntry;
  /** Final score — higher means "put this near the top of the submission's friction log." */
  total: number;
  tagScore: number;
  keywordScore: number;
  recencyScore: number;
  /** Human-readable, in the order the three components above are computed — this is what makes the ranking explainable rather than a black box. */
  reasons: string[];
}

const TAG_WEIGHTS: Record<string, number> = {
  friction: 5,
  "feature-request": 2,
  note: 1,
  "worked-well": 0,
};

/** An unrecognized custom tag (anything other than the three well-known ones or the default "note") is treated like "note" — a mild, unremarkable weight. */
function tagWeight(tag: string): number {
  return tag in TAG_WEIGHTS ? TAG_WEIGHTS[tag] : 1;
}

export interface SeverityKeywordRule {
  weight: number;
  /** Lowercase keywords/phrases, matched the same way `autotag.ts` does: a single word on a `\b` boundary, a multi-word phrase as a plain substring. */
  keywords: string[];
}

/**
 * Escalating severity language. Each rule contributes its weight **once**
 * per matching entry (not once per keyword occurrence), so a note repeating
 * "crash crash crash" doesn't get 3x credit for saying the same thing three
 * times — only for how severe the *kind* of language it uses is.
 */
export const HIGH_SEVERITY_RULES: SeverityKeywordRule[] = [
  {
    weight: 4,
    keywords: [
      "blocker",
      "blocked",
      "blocking",
      "showstopper",
      "critical",
      "unrecoverable",
      "data loss",
      "security",
    ],
  },
  {
    weight: 3,
    keywords: [
      "crash",
      "crashed",
      "crashes",
      "dead end",
      "deadlock",
      "gave up",
      "couldn't",
      "could not",
      "impossible",
      "completely broken",
      "no way to",
      "unusable",
    ],
  },
  {
    weight: 2,
    keywords: [
      "hours",
      "all day",
      "confusing",
      "confused",
      "stuck",
      "broke",
      "broken",
      "breaks",
      "error",
      "errors",
      "fail",
      "failed",
      "failing",
    ],
  },
];

/** Hedging language that suggests an entry is genuinely minor, pulling its score back down instead of leaving it to rank purely on tag. */
export const LOW_SEVERITY_RULES: SeverityKeywordRule[] = [
  {
    weight: -2,
    keywords: ["minor", "small", "slightly", "cosmetic", "nit", "nitpick", "trivial", "quick fix"],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesKeyword(lowerText: string, keyword: string): boolean {
  const pattern = keyword.includes(" ") ? escapeRegExp(keyword) : `\\b${escapeRegExp(keyword)}\\b`;
  return new RegExp(pattern).test(lowerText);
}

function keywordScoreFor(note: string): { score: number; reasons: string[] } {
  const lower = note.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  for (const rule of [...HIGH_SEVERITY_RULES, ...LOW_SEVERITY_RULES]) {
    const matched = rule.keywords.find((k) => matchesKeyword(lower, k));
    if (matched !== undefined) {
      score += rule.weight;
      const sign = rule.weight > 0 ? "+" : "";
      const direction = rule.weight > 0 ? "raises" : "lowers";
      reasons.push(`wording "${matched}" ${direction} severity (${sign}${rule.weight})`);
    }
  }
  return { score, reasons };
}

/**
 * Scores every entry in `entries` **relative to this set** — recency is a
 * rank within whatever's being scored, so the same entry can score
 * differently in `top --since ...` on a narrower window than over the whole
 * log — and returns them sorted highest-severity first (ties broken by more
 * recent first, since a tie usually means "equally bad, so surface the one
 * still fresh").
 */
export function scoreEntries(entries: LogEntry[]): SeverityBreakdown[] {
  if (entries.length === 0) return [];

  const times = entries.map((e) => Date.parse(e.timestamp));
  const validTimes = times.filter((t) => !Number.isNaN(t));
  const minT = validTimes.length > 0 ? Math.min(...validTimes) : 0;
  const maxT = validTimes.length > 0 ? Math.max(...validTimes) : 0;
  const span = maxT - minT;

  const scored = entries.map((entry, i) => {
    const reasons: string[] = [];

    const tScore = tagWeight(entry.tag);
    reasons.push(`tagged "${entry.tag}" (${tScore >= 0 ? "+" : ""}${tScore})`);

    const { score: kScore, reasons: kReasons } = keywordScoreFor(entry.note);
    reasons.push(...kReasons);

    const t = times[i];
    const recencyRatio = span > 0 && !Number.isNaN(t) ? (t - minT) / span : 0.5;
    const rScore = Math.round(recencyRatio * 3 * 10) / 10; // 0..3, one decimal place
    const recencyLabel =
      recencyRatio >= 0.66
        ? "one of the more recent entries"
        : recencyRatio <= 0.33
          ? "one of the earlier entries"
          : "logged around the midpoint of this range";
    reasons.push(`${recencyLabel} (+${rScore.toFixed(1)} recency)`);

    const total = Math.round((tScore + kScore + rScore) * 10) / 10;
    return { entry, total, tagScore: tScore, keywordScore: kScore, recencyScore: rScore, reasons };
  });

  scored.sort((a, b) => b.total - a.total || Date.parse(b.entry.timestamp) - Date.parse(a.entry.timestamp));
  return scored;
}
