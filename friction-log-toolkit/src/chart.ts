/**
 * A tiny, dependency-free ASCII bar chart — used by `stats` to show entry
 * counts per day. One line per day that has at least one entry (a log
 * spanning a huge date range with long gaps doesn't print a wall of empty
 * days), sorted chronologically.
 */

export interface DailyCount {
  /** "YYYY-MM-DD" */
  date: string;
  count: number;
}

const MAX_BAR_WIDTH = 40;
const BAR_CHAR = "█"; // █

/**
 * Renders one line per day: `"<date> |<bar> <count>"`.
 *
 * Below `MAX_BAR_WIDTH`, a bar is exactly `count` block characters long —
 * so you can eyeball the exact count directly off the bar, not just the
 * trailing number. Only once the busiest day's count exceeds
 * `MAX_BAR_WIDTH` does every bar get scaled down by the same factor (so the
 * busiest day's bar becomes exactly `MAX_BAR_WIDTH` characters and every
 * other day's bar shrinks proportionally with it) — keeping a single very
 * busy day from blowing out terminal width while preserving relative
 * proportions between days.
 */
export function renderBarChart(daily: DailyCount[]): string[] {
  if (daily.length === 0) return [];
  const maxCount = Math.max(...daily.map((d) => d.count));
  const scale = maxCount > MAX_BAR_WIDTH ? MAX_BAR_WIDTH / maxCount : 1;
  return daily.map(({ date, count }) => {
    const barLength = Math.max(1, Math.round(count * scale));
    return `${date} |${BAR_CHAR.repeat(barLength)} ${count}`;
  });
}
