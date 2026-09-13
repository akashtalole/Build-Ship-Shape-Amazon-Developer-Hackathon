import { getBudgetStatus, getHousehold, itemsRunningLow, openTaskCounts } from "./store.js";

/**
 * Proactive anomaly detection over data every other tool already reads —
 * this module adds no new persisted state of its own. The point is
 * surfacing things worth attention *before* anyone asks about them, which is
 * a different job than any existing read tool: list_upcoming_tasks answers
 * "what's due", get_budget_status answers "are we over budget right now",
 * list_low_stock_items answers "what's low right now" — none of them answer
 * "is anything trending toward a problem".
 */

export type AnomalyType = "task_pileup" | "spending_trend" | "stale_low_stock";

export interface HouseholdAnomaly {
  type: AnomalyType;
  severity: "notice" | "warning";
  message: string;
  data: Record<string, unknown>;
}

// A gap of at least this many open tasks between the most- and
// least-loaded member, with the most-loaded member carrying at least this
// many, is treated as a pileup rather than ordinary day-to-day variance.
const PILEUP_MIN_GAP = 2;
const PILEUP_MIN_LOAD = 3;

// "Trending" is measured as projected weekly spend (this category's spend
// so far this rolling week, annualized — well, weekly-ized — over the number
// of days since its first expense in that window) versus budget. 1.3 means
// "on pace to land 30% over budget by the end of the week", which is a
// meaningfully different (and earlier) signal than "already over budget".
const SPENDING_TREND_PACE_RATIO = 1.3;

// A low-stock item whose last reorder (or, if it has never been reordered,
// however long it's simply been tracked) is at least this many days old is
// "stale" — it's been sitting on the low-stock list long enough that it's
// probably not just about to be reordered anyway.
const STALE_LOW_STOCK_DAYS = 14;

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000));
}

/** Flags a household member carrying a meaningfully larger open-task load than the least-loaded member. */
export function detectTaskPileup(householdId: string): HouseholdAnomaly[] {
  const counts = openTaskCounts(householdId);
  if (counts.length < 2) return [];

  const sorted = [...counts].sort((a, b) => b.openTasks - a.openTasks);
  const most = sorted[0];
  const least = sorted[sorted.length - 1];
  const gap = most.openTasks - least.openTasks;

  if (gap < PILEUP_MIN_GAP || most.openTasks < PILEUP_MIN_LOAD) return [];

  return [
    {
      type: "task_pileup",
      severity: "notice",
      message: `${most.member} has ${most.openTasks} open task(s), ${gap} more than ${least.member} (${least.openTasks}). Chores may be piling up unevenly.`,
      data: { counts, mostLoaded: most.member, leastLoaded: least.member, gap },
    },
  ];
}

/**
 * Flags a budget category that isn't over budget yet, but whose spend so far
 * this rolling week — projected out at its current pace — is on track to
 * land well over it. Uses the raw expense list (not just getBudgetStatus's
 * totals) so "pace" reflects how few days it took to reach the current
 * spend, not just the spend itself.
 */
export function detectSpendingTrends(householdId: string): HouseholdAnomaly[] {
  const household = getHousehold(householdId);
  const budgets = getBudgetStatus(householdId);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const anomalies: HouseholdAnomaly[] = [];
  for (const status of budgets) {
    if (status.overBudget || status.budget <= 0 || status.spentThisWeek <= 0) continue;

    const categoryExpenses = household.expenses.filter(
      (e) => e.category === status.category && new Date(e.loggedAt) >= weekAgo
    );
    if (categoryExpenses.length === 0) continue;

    const earliest = categoryExpenses.reduce((min, e) => (e.loggedAt < min ? e.loggedAt : min), categoryExpenses[0].loggedAt);
    const daysElapsed = Math.max(1, daysSince(earliest) + 1);
    const projectedWeeklySpend = (status.spentThisWeek / daysElapsed) * 7;
    const paceRatio = projectedWeeklySpend / status.budget;

    if (paceRatio >= SPENDING_TREND_PACE_RATIO) {
      anomalies.push({
        type: "spending_trend",
        severity: "warning",
        message:
          `${status.category} has spent ${status.spentThisWeek.toFixed(2)} of its ${status.budget.toFixed(2)} weekly budget ` +
          `in just ${daysElapsed} day(s) — on pace for ~${projectedWeeklySpend.toFixed(2)} by week's end, ` +
          `${Math.round((paceRatio - 1) * 100)}% over budget if it keeps up.`,
        data: {
          category: status.category,
          spentThisWeek: status.spentThisWeek,
          budget: status.budget,
          daysElapsed,
          projectedWeeklySpend: Math.round(projectedWeeklySpend * 100) / 100,
          paceRatio: Math.round(paceRatio * 100) / 100,
        },
      });
    }
  }
  return anomalies;
}

/** Flags a low-stock item that's been low for a long time without a (recent) reorder. */
export function detectStaleLowStock(householdId: string): HouseholdAnomaly[] {
  return itemsRunningLow(householdId)
    .filter((item) => !item.lastOrderedAt || daysSince(item.lastOrderedAt) >= STALE_LOW_STOCK_DAYS)
    .map((item) => {
      const ageDays = item.lastOrderedAt ? daysSince(item.lastOrderedAt) : undefined;
      return {
        type: "stale_low_stock" as const,
        severity: "notice" as const,
        message: item.lastOrderedAt
          ? `${item.name} has been running low for ${ageDays} day(s) since its last reorder and still hasn't been restocked.`
          : `${item.name} is running low and has no reorder on record at all.`,
        data: { itemId: item.id, itemName: item.name, quantityOnHand: item.quantityOnHand, lastOrderedAt: item.lastOrderedAt ?? null, ageDays: ageDays ?? null },
      };
    });
}

export function computeHouseholdAnomalies(householdId: string): HouseholdAnomaly[] {
  return [...detectTaskPileup(householdId), ...detectSpendingTrends(householdId), ...detectStaleLowStock(householdId)];
}
