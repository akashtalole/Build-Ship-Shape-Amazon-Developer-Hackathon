import type { RecurrenceRule } from "./types.js";

function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Is `now` inside the recurring window described by `rule`? All comparisons
 * are done in UTC (see the doc comment on `RecurrenceRule`).
 *
 * Handles the midnight-crossing case (`startTime` > `endTime`, e.g.
 * "22:00" -> "02:00") by treating the overnight window as "belonging" to the
 * day it starts on: it's a match either later that same day (>= startTime)
 * or in the small hours of the following day (< endTime), as long as the
 * *starting* day is one of `daysOfWeek`.
 */
export function isWithinRecurrence(rule: RecurrenceRule, now: Date): boolean {
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = parseHHMM(rule.startTime);
  const endMinutes = parseHHMM(rule.endTime);
  const today = now.getUTCDay();

  if (startMinutes < endMinutes) {
    // Ordinary same-day window, e.g. 13:00-15:00.
    return rule.daysOfWeek.includes(today) && nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  if (startMinutes > endMinutes) {
    // Overnight window, e.g. 22:00-02:00. It "starts" on `today`.
    const yesterday = (today + 6) % 7;
    if (rule.daysOfWeek.includes(today) && nowMinutes >= startMinutes) return true;
    if (rule.daysOfWeek.includes(yesterday) && nowMinutes < endMinutes) return true;
    return false;
  }

  // startTime === endTime is a zero-length window by construction — never valid.
  return false;
}
