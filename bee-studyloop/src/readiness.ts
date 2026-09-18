import type { RecallGrade } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Weights sum to 100 — same "explicit, documented, not pretending to be more
// rigorous than it is" spirit as priority.ts's weights (see FRICTION_LOG.md).
const SCHEDULE_WEIGHT = 50; // fraction of cards not currently due/overdue
const PERFORMANCE_WEIGHT = 35; // recency-weighted recent grade history
const STREAK_WEIGHT = 15; // current study streak, capped at STREAK_CAP_DAYS

const STREAK_CAP_DAYS = 7;
const RECENCY_HALF_LIFE_DAYS = 14;

const GRADE_QUALITY: Record<RecallGrade, number> = {
  again: 0,
  hard: 0.4,
  good: 0.75,
  easy: 1,
};

export interface ReadinessCardInput {
  dueAt: string;
  isLeech: boolean;
  lastGrade?: RecallGrade;
  lastReviewedAt?: string;
}

export interface ReadinessBreakdown {
  score: number; // 0-100
  cardCount: number;
  dueCount: number;
  overdueCount: number; // due more than a full day ago
  leechCount: number;
  notDueFraction: number; // 0..1 — the component behind SCHEDULE_WEIGHT
  recentPerformance: number; // 0..1 — the component behind PERFORMANCE_WEIGHT
  streakDays: number;
  reasons: string[]; // plain-language explanation of what's dragging the score down
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Composite, explainable exam-readiness score (0-100) for a pool of cards
 * (a topic's or deck's) plus the reviewer's current study streak. Combines
 * three signals already tracked elsewhere in the store — the scheduler's due
 * state, each card's own last recall grade, and streak.ts's streak state —
 * into one number with a plain-language breakdown, rather than inventing new
 * state to track:
 *
 *   score = notDueFraction * SCHEDULE_WEIGHT        (50 of 100)
 *         + recentPerformance * PERFORMANCE_WEIGHT  (35 of 100)
 *         + streakFactor * STREAK_WEIGHT            (15 of 100)
 *
 * - `notDueFraction` — the share of cards that are NOT currently due. SM-2
 *   pushes a card's due date out precisely because it's been recalled
 *   reliably, so a deck that's entirely overdue scores 0 here no matter how
 *   well it was once known — "was known" isn't "is exam-ready right now."
 * - `recentPerformance` — each card with a recorded `lastGrade` contributes
 *   its quality (again=0, hard=0.4, good=0.75, easy=1), weighted by an
 *   exponential recency decay (half-life `RECENCY_HALF_LIFE_DAYS`) so a
 *   grade from yesterday counts far more than one from months ago — this is
 *   "recent" grade history, not just "any" grade history, per the spec. A
 *   pool with no review history yet gets a neutral 0.5 (not 0): "unreviewed"
 *   isn't the same signal as "reviewed and struggled."
 * - `streakFactor` — `min(currentStreak, STREAK_CAP_DAYS) / STREAK_CAP_DAYS`.
 *   Consistent daily review is a real readiness signal independent of any
 *   one card's own state; capped so an extremely long streak can't drown out
 *   the other two, more card-specific signals.
 *
 * Every weight/cap is a documented, admittedly-arbitrary choice (there's no
 * usage data to tune against, same honest tradeoff `priority.ts` already
 * made) rather than dressed up as more rigorous than it is — see
 * FRICTION_LOG.md.
 */
export function computeReadiness(cards: ReadinessCardInput[], currentStreak: number, now: Date = new Date()): ReadinessBreakdown {
  const cardCount = cards.length;
  if (cardCount === 0) {
    return {
      score: 0,
      cardCount: 0,
      dueCount: 0,
      overdueCount: 0,
      leechCount: 0,
      notDueFraction: 0,
      recentPerformance: 0,
      streakDays: currentStreak,
      reasons: ["No flashcards found for this yet — nothing to assess."],
    };
  }

  const dueCards = cards.filter((c) => new Date(c.dueAt).getTime() <= now.getTime());
  const overdueCards = cards.filter((c) => now.getTime() - new Date(c.dueAt).getTime() > MS_PER_DAY);
  const leechCards = cards.filter((c) => c.isLeech);
  const notDueFraction = (cardCount - dueCards.length) / cardCount;

  const graded = cards.filter(
    (c): c is ReadinessCardInput & { lastGrade: RecallGrade; lastReviewedAt: string } => Boolean(c.lastGrade && c.lastReviewedAt)
  );
  let recentPerformance = 0.5;
  if (graded.length > 0) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const c of graded) {
      const daysAgo = Math.max(0, (now.getTime() - new Date(c.lastReviewedAt).getTime()) / MS_PER_DAY);
      const weight = Math.pow(0.5, daysAgo / RECENCY_HALF_LIFE_DAYS);
      weightedSum += weight * GRADE_QUALITY[c.lastGrade];
      weightTotal += weight;
    }
    recentPerformance = weightTotal > 0 ? weightedSum / weightTotal : 0.5;
  }

  const streakFactor = Math.min(Math.max(0, currentStreak), STREAK_CAP_DAYS) / STREAK_CAP_DAYS;
  const rawScore = notDueFraction * SCHEDULE_WEIGHT + recentPerformance * PERFORMANCE_WEIGHT + streakFactor * STREAK_WEIGHT;

  const reasons: string[] = [];
  if (overdueCards.length > 0) reasons.push(`${pluralize(overdueCards.length, "card")} overdue`);
  if (leechCards.length > 0) reasons.push(`${pluralize(leechCards.length, "leech")} unresolved`);
  if (graded.length === 0) reasons.push("no review history yet");
  else if (recentPerformance < 0.5) reasons.push("recent grades have been weak");
  if (currentStreak === 0) reasons.push("no active study streak");
  if (reasons.length === 0) reasons.push("nothing dragging this down — keep it up");

  return {
    score: Math.max(0, Math.min(100, Math.round(rawScore))),
    cardCount,
    dueCount: dueCards.length,
    overdueCount: overdueCards.length,
    leechCount: leechCards.length,
    notDueFraction,
    recentPerformance,
    streakDays: currentStreak,
    reasons,
  };
}
