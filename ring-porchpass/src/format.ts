/**
 * Small shared formatting helpers used by both the visit-duration flow
 * (`passService.ts`) and the traffic report (`analytics.ts`) — pulled out
 * here rather than duplicated in each, since both need "turn a millisecond
 * duration into something a homeowner can read" and there's no reason for
 * that phrasing to drift between a checkout notification and an analytics
 * insight string.
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${minutes}m`;
}

export const DAY_NAMES_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Formats an hour-of-day (0-23, UTC) as e.g. "2 PM". */
export function formatHourUtc(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour} ${period}`;
}
