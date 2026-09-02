import type { Flashcard } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Tunable weights — see the formula writeup below and FRICTION_LOG.md for
// the reasoning/tradeoffs behind these specific numbers.
const OVERDUE_WEIGHT = 1;
const LEECH_BONUS = 10;
const EASE_WEIGHT = 2;
const BASELINE_EASE = 2.5; // scheduler.ts's DEFAULT_EASE_FACTOR

/** The subset of a flashcard's fields the priority formula reads. */
export type PriorityInput = Pick<Flashcard, "dueAt" | "isLeech" | "easeFactor">;

/**
 * Adaptive review priority score for `GET /review/due`. Plain due-date order
 * treats "just became due a minute ago" the same as "overdue by three
 * weeks," and doesn't distinguish a card that's historically easy from one
 * that keeps tripping the student up. This combines three signals instead:
 *
 *   score = overdueDays * OVERDUE_WEIGHT
 *         + (isLeech ? LEECH_BONUS : 0)
 *         + max(0, BASELINE_EASE - easeFactor) * EASE_WEIGHT
 *
 * - `overdueDays` — how many days past its scheduled `dueAt` the card is
 *   (0 for a card that just became due). The longer it's been put off, the
 *   more urgent it is.
 * - `isLeech` gets a large flat bonus (10, worth ~10 days of overdue-ness)
 *   so a leech sorts near the top almost regardless of how "on time" it
 *   otherwise is. Leech-flagging exists specifically so these cards get
 *   surfaced and reformulated instead of silently rescheduled forever, so
 *   the ranking has to actually put them in front of the student.
 * - `easeFactor` (SM-2's E-Factor) tracks how consistently hard a card has
 *   been to recall — every below-average grade nudges it down from the 2.5
 *   default, every strong grade nudges it up. A below-baseline ease earns a
 *   priority boost too, on the theory that "generally difficult" cards
 *   deserve to be seen sooner, but the boost is smaller than the leech bonus
 *   since being merely hard isn't the same red flag as 3 failures running.
 *
 * Cards that aren't due yet are filtered out before this ever runs — this
 * only reorders the pool that's already eligible for review today.
 */
export function priorityScore(card: PriorityInput, now: Date = new Date()): number {
  const overdueDays = Math.max(0, (now.getTime() - new Date(card.dueAt).getTime()) / MS_PER_DAY);
  const leechBonus = card.isLeech ? LEECH_BONUS : 0;
  const easeUrgency = Math.max(0, BASELINE_EASE - card.easeFactor) * EASE_WEIGHT;
  return overdueDays * OVERDUE_WEIGHT + leechBonus + easeUrgency;
}
