import type { RecallGrade } from "./types.js";

/** Number of consecutive failing ("again") grades before a card is flagged as a leech. */
export const LEECH_THRESHOLD = 3;

export interface LeechState {
  consecutiveFailures: number;
  isLeech: boolean;
}

/** Leech state for a freshly generated card that has never been reviewed. */
export function initialLeechState(): LeechState {
  return { consecutiveFailures: 0, isLeech: false };
}

/**
 * Leech-detection state machine. Kept separate from scheduler.ts's interval
 * math because it answers a different question: not "when should this be
 * reviewed again" but "has this specific card become a chronic problem that
 * rescheduling alone won't fix." A card is flagged as a leech once it has
 * failed ("again") `LEECH_THRESHOLD` times in a row; a single "good" or
 * "easy" grade clears the flag and resets the streak, on the theory that one
 * solid recall means the card (or the student's grasp of it) has recovered.
 * A "hard" grade is a lukewarm pass — it neither advances nor resets the
 * failure streak, since it's not a failure but not a confident recall either.
 */
export function updateLeechState(state: LeechState, grade: RecallGrade): LeechState {
  if (grade === "again") {
    const consecutiveFailures = state.consecutiveFailures + 1;
    return { consecutiveFailures, isLeech: consecutiveFailures >= LEECH_THRESHOLD };
  }
  if (grade === "good" || grade === "easy") {
    return { consecutiveFailures: 0, isLeech: false };
  }
  return state; // "hard": leave the streak untouched.
}
