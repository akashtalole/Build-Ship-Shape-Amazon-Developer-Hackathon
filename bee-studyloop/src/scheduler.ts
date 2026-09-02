import type { RecallGrade } from "./types.js";

/**
 * The subset of a flashcard's fields the scheduler reads and rewrites. Kept
 * as a narrow interface (rather than importing the full `Flashcard` type) so
 * these functions stay pure and trivially unit-testable in isolation from
 * storage.
 */
export interface SchedulerState {
  interval: number; // days
  easeFactor: number;
  repetitions: number;
  dueAt: string; // ISO timestamp
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_EASE_FACTOR = 1.3;
const DEFAULT_EASE_FACTOR = 2.5;

// Maps the friendly four-point grade onto the 0-5 "quality of recall" score
// the original SM-2 algorithm operates on. 3 is the pass/fail boundary.
const GRADE_TO_QUALITY: Record<RecallGrade, number> = {
  again: 1,
  hard: 3,
  good: 4,
  easy: 5,
};

/** Scheduling state for a card that has never been reviewed: due immediately. */
export function initialSchedulerState(now: Date = new Date()): SchedulerState {
  return {
    interval: 0,
    easeFactor: DEFAULT_EASE_FACTOR,
    repetitions: 0,
    dueAt: now.toISOString(),
  };
}

/**
 * Simplified SM-2: given a card's current scheduling state and a recall
 * grade, returns the next state. A failing grade ("again", quality < 3)
 * resets the repetition streak and drops the card back to a 1-day interval
 * instead of continuing to grow it; a passing grade advances the streak and
 * grows the interval (1 day -> 6 days -> interval * easeFactor).
 */
export function scheduleReview(state: SchedulerState, grade: RecallGrade, now: Date = new Date()): SchedulerState {
  const quality = GRADE_TO_QUALITY[grade];
  let { interval, repetitions } = state;
  let easeFactor = state.easeFactor;

  if (quality < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions += 1;
  }

  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (easeFactor < MIN_EASE_FACTOR) easeFactor = MIN_EASE_FACTOR;

  const dueAt = new Date(now.getTime() + interval * MS_PER_DAY).toISOString();

  return { interval, easeFactor, repetitions, dueAt };
}

/** A card is due once its scheduled `dueAt` has passed (or is now). */
export function isDue(state: SchedulerState, now: Date = new Date()): boolean {
  return new Date(state.dueAt).getTime() <= now.getTime();
}
