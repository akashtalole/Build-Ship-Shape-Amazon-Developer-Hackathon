/**
 * Study streaks & gamification. Kept as its own pure module (mirroring
 * scheduler.ts/leech.ts) so the "what counts as a streak day, and when does
 * it reset" logic is unit-testable in isolation from storage and HTTP.
 *
 * A "streak day" is any UTC calendar day (`YYYY-MM-DD`, taken from the ISO
 * timestamp) on which a student completed at least one review — see
 * `recordStreakActivity` in studyService.ts, invoked from
 * `recordReviewForStudent`. Multiple reviews on the same day count once.
 * Consecutive streak days grow `currentStreak`; a gap of more than one day
 * resets it back to 1 (the day just reviewed still counts) without touching
 * `longestStreak`, which only ever grows. Badges are milestones on
 * `longestStreak` — once earned they're never revoked, even after the
 * current streak later resets, matching how most habit-tracking apps treat
 * a badge as a permanent achievement rather than a live status.
 */

/** Consecutive-day milestones that earn a badge. */
export const STREAK_MILESTONES = [3, 7, 30] as const;

export interface StreakState {
  studentId: string;
  /** UTC calendar day (`YYYY-MM-DD`) of the most recent streak-counted review, or "" if none yet. */
  lastActiveDate: string;
  currentStreak: number;
  longestStreak: number;
}

export interface StreakSummary {
  studentId: string;
  currentStreak: number;
  longestStreak: number;
  badges: string[];
  lastActiveDate?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The UTC calendar-day key a timestamp falls on, e.g. "2026-01-01". */
function dateKey(when: Date): string {
  return when.toISOString().slice(0, 10);
}

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / MS_PER_DAY);
}

/** Streak state for a student who has never completed a review. */
export function initialStreakState(studentId: string): StreakState {
  return { studentId, lastActiveDate: "", currentStreak: 0, longestStreak: 0 };
}

/**
 * Folds one more completed-review event (at time `now`) into a student's
 * streak state. Safe to call once per review — a second call the same UTC
 * day is a no-op, so reviewing ten cards in one sitting only ever counts as
 * one streak day, exactly as "at least one completed review" per day
 * requires.
 *
 * A review timestamped *before* the student's current `lastActiveDate`
 * (e.g. an out-of-order replay) is also a no-op: streaks only ever advance
 * forward in time, so a backdated event can't retroactively rewrite a streak
 * that was already computed from later activity.
 */
export function recordStreakDay(state: StreakState, now: Date = new Date()): StreakState {
  const today = dateKey(now);

  if (!state.lastActiveDate) {
    return { ...state, lastActiveDate: today, currentStreak: 1, longestStreak: Math.max(1, state.longestStreak) };
  }

  const gap = daysBetween(state.lastActiveDate, today);
  if (gap === 0) return state; // already counted today
  if (gap < 0) return state; // backdated event; ignore rather than rewrite history

  const currentStreak = gap === 1 ? state.currentStreak + 1 : 1; // consecutive day vs. a missed gap
  const longestStreak = Math.max(state.longestStreak, currentStreak);
  return { ...state, lastActiveDate: today, currentStreak, longestStreak };
}

/** Milestone badges earned so far, based on the *longest* streak ever reached (permanent, never revoked). */
export function badgesForStreak(longestStreak: number): string[] {
  return STREAK_MILESTONES.filter((m) => longestStreak >= m).map((m) => `${m}-day-streak`);
}

export function toStreakSummary(state: StreakState): StreakSummary {
  return {
    studentId: state.studentId,
    currentStreak: state.currentStreak,
    longestStreak: state.longestStreak,
    badges: badgesForStreak(state.longestStreak),
    lastActiveDate: state.lastActiveDate || undefined,
  };
}
