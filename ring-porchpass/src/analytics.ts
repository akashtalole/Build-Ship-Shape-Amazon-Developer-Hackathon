import { getPassById, listVisits } from "./store.js";
import { DAY_NAMES_FULL, formatDuration, formatHourUtc } from "./format.js";

/**
 * Traffic/analytics report — `GET /analytics` (aliased at `GET /reports/traffic`).
 * Same spirit as the "StoreWatch" idea in `hackathon-ideas/ring.md` ("plain-
 * language insights... rather than raw event logs"), folded into PorchPass's
 * own visit history instead of a separate project: every number here comes
 * straight from the real `Visit` records `GET /visits` already exposes (plus
 * each visit's pass, for its `note` category) — there's no separate
 * analytics data store to keep in sync, so this is always as current as the
 * last check-in or checkout.
 */

export interface TrafficReport {
  generatedAt: string;
  totalVisits: number;
  completedVisits: number;
  onSiteNow: number;
  busiestDay?: { day: string; count: number };
  busiestHour?: { hourUtc: number; label: string; count: number };
  averageVisitDurationMs?: number;
  visitsByVisitor: Array<{ visitorName: string; count: number }>;
  visitsByCategory: Array<{ category: string; count: number }>;
  insights: string[];
}

function maxEntry<K>(counts: Map<K, number>): [K, number] | undefined {
  let best: [K, number] | undefined;
  for (const entry of counts) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best;
}

export function buildTrafficReport(now: Date = new Date()): TrafficReport {
  const visits = listVisits();

  const dayCounts = new Map<number, number>();
  const hourCounts = new Map<number, number>();
  const visitorCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  let totalCompletedDurationMs = 0;
  let completedVisits = 0;
  let onSiteNow = 0;

  for (const visit of visits) {
    const checkedInAt = new Date(visit.checkedInAt);
    dayCounts.set(checkedInAt.getUTCDay(), (dayCounts.get(checkedInAt.getUTCDay()) ?? 0) + 1);
    hourCounts.set(checkedInAt.getUTCHours(), (hourCounts.get(checkedInAt.getUTCHours()) ?? 0) + 1);
    visitorCounts.set(visit.visitorName, (visitorCounts.get(visit.visitorName) ?? 0) + 1);

    // The visit itself only knows visitorName/passId — the "dog walker" vs.
    // "delivery" category lives on the Pass it came from, via its optional
    // `note`. A pass that was later revoked or has since expired still has
    // its record in the store, so this join keeps working for historical
    // visits regardless of the pass's *current* status.
    const pass = getPassById(visit.passId);
    const category = pass?.note ?? "uncategorized";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);

    if (visit.checkedOutAt && visit.durationMs !== undefined) {
      totalCompletedDurationMs += visit.durationMs;
      completedVisits += 1;
    } else {
      onSiteNow += 1;
    }
  }

  const busiestDayEntry = maxEntry(dayCounts);
  const busiestHourEntry = maxEntry(hourCounts);
  const averageVisitDurationMs = completedVisits > 0 ? Math.round(totalCompletedDurationMs / completedVisits) : undefined;
  const topCategoryEntry = maxEntry(categoryCounts);
  const topVisitorEntry = maxEntry(visitorCounts);

  const insights: string[] = [];
  if (visits.length === 0) {
    insights.push("No visits recorded yet — insights will appear once visitors start checking in.");
  } else {
    if (busiestDayEntry) {
      const [day, count] = busiestDayEntry;
      insights.push(`${DAY_NAMES_FULL[day]} is your busiest day (${count} visit${count === 1 ? "" : "s"}).`);
    }
    if (busiestHourEntry) {
      const [hour, count] = busiestHourEntry;
      insights.push(`Most visits happen around ${formatHourUtc(hour)} UTC (${count} visit${count === 1 ? "" : "s"}).`);
    }
    if (averageVisitDurationMs !== undefined) {
      insights.push(`The average completed visit lasts ${formatDuration(averageVisitDurationMs)}.`);
    }
    if (topCategoryEntry && topCategoryEntry[0] !== "uncategorized") {
      const [category, count] = topCategoryEntry;
      insights.push(`"${category}" is your most common visit type (${count} visit${count === 1 ? "" : "s"}).`);
    }
    if (topVisitorEntry && topVisitorEntry[1] > 1) {
      const [visitorName, count] = topVisitorEntry;
      insights.push(`${visitorName} has visited the most (${count} times).`);
    }
    if (onSiteNow > 0) {
      insights.push(`${onSiteNow} visitor${onSiteNow === 1 ? " is" : "s are"} currently on-site.`);
    }
  }

  return {
    generatedAt: now.toISOString(),
    totalVisits: visits.length,
    completedVisits,
    onSiteNow,
    busiestDay: busiestDayEntry ? { day: DAY_NAMES_FULL[busiestDayEntry[0]], count: busiestDayEntry[1] } : undefined,
    busiestHour: busiestHourEntry
      ? { hourUtc: busiestHourEntry[0], label: formatHourUtc(busiestHourEntry[0]), count: busiestHourEntry[1] }
      : undefined,
    averageVisitDurationMs,
    visitsByVisitor: [...visitorCounts.entries()]
      .map(([visitorName, count]) => ({ visitorName, count }))
      .sort((a, b) => b.count - a.count),
    visitsByCategory: [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    insights,
  };
}
