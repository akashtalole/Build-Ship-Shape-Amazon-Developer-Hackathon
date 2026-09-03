import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BudgetStatus, Expense, Household, ShoppingItem, Task } from "./types.js";

// The household used for any request that carries no (or an unrecognized)
// bearer token — see src/auth.ts. Kept as a fixed ID so its seeded demo data
// (below) and existing docs/tests keep working without a token.
export const DEFAULT_HOUSEHOLD_ID = "home-1";

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// Persistence
//
// Each household is a JSON file on disk (data/<householdId>.json by
// default, overridable via HOMEOPS_DATA_DIR — the smoke test points this at
// a scratch directory so test runs never share state with real usage or
// with each other). There's deliberately no long-lived in-memory cache: every
// store function reads the file fresh and writes it back after mutating.
// That's what makes "restart the server, data survives" true (a second
// process — or a second McpServer instance in the same process — reads the
// same file and sees the first one's writes) at the cost of a stat+read per
// call, which is a fine tradeoff for a demo-scale single-instance server.
// This is NOT a database: there's no locking beyond what atomic rename
// gives a single writer, so concurrent writers racing on the exact same
// household could still interleave. See README.md's persistence section.
// --------------------------------------------------------------------------

function dataDir(): string {
  return process.env.HOMEOPS_DATA_DIR
    ? path.resolve(process.env.HOMEOPS_DATA_DIR)
    : path.resolve(process.cwd(), "data");
}

function householdFilePath(householdId: string): string {
  return path.join(dataDir(), `${householdId}.json`);
}

function ensureDataDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}

function seedHousehold(householdId: string): Household {
  if (householdId === DEFAULT_HOUSEHOLD_ID) {
    return {
      id: DEFAULT_HOUSEHOLD_ID,
      name: "The Family Home",
      members: ["Jordan", "Sam"],
      tasks: [
        { id: randomUUID(), title: "Take out recycling", dueDate: daysFromNow(0), assignee: "Jordan", done: false },
        { id: randomUUID(), title: "Pay electricity bill", dueDate: daysFromNow(2), assignee: "Sam", done: false },
        { id: randomUUID(), title: "Vet appointment for the dog", dueDate: daysFromNow(5), assignee: "Jordan", done: false },
      ],
      shoppingItems: [
        { id: randomUUID(), name: "Paper towels", quantityOnHand: 1, reorderThreshold: 2 },
        { id: randomUUID(), name: "Dish soap", quantityOnHand: 3, reorderThreshold: 1 },
        { id: randomUUID(), name: "Dog food", quantityOnHand: 0, reorderThreshold: 1, lastOrderedAt: daysFromNow(-30) },
      ],
      expenses: [],
      budgets: { groceries: 150, pets: 60, utilities: 200 },
    };
  }

  // Any other household ID (i.e. any distinct bearer token) starts out
  // fresh and empty on first use — no pre-registration, no shared demo
  // data. A single generic member is seeded so fair-rotation logic (which
  // needs at least one household member to assign to) works immediately;
  // real usage would let the household rename/add members over time.
  return {
    id: householdId,
    name: "New Household",
    members: ["You"],
    tasks: [],
    shoppingItems: [],
    expenses: [],
    budgets: {},
  };
}

function loadHousehold(householdId: string): Household {
  const file = householdFilePath(householdId);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as Household;
    } catch {
      // Corrupt/partial file (e.g. a crash mid-write somehow survived the
      // atomic rename) — fall through and reseed rather than crash the
      // server on a bad read.
    }
  }
  const fresh = seedHousehold(householdId);
  saveHousehold(householdId, fresh);
  return fresh;
}

function saveHousehold(householdId: string, household: Household): void {
  ensureDataDir();
  const file = householdFilePath(householdId);
  // Write-to-temp-then-rename so a reader never observes a half-written
  // file: rename is atomic on the same filesystem, so the file at `file`
  // is always either the previous complete version or the new complete
  // version, never a partial write.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(household, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

// --------------------------------------------------------------------------
// Shared logic
// --------------------------------------------------------------------------

/**
 * Picks the household member with the fewest open (not-done) tasks, so
 * chores get distributed fairly instead of always landing on whoever is
 * asked first. Ties break in favor of whoever appears first in the
 * household's member list.
 */
function computeSuggestedAssignee(household: Household): string {
  const openCounts = new Map(household.members.map((m) => [m, 0]));
  for (const task of household.tasks) {
    if (!task.done && task.assignee && openCounts.has(task.assignee)) {
      openCounts.set(task.assignee, openCounts.get(task.assignee)! + 1);
    }
  }
  return [...openCounts.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

function computeOpenTaskCounts(household: Household): { member: string; openTasks: number }[] {
  const openCounts = new Map(household.members.map((m) => [m, 0]));
  for (const task of household.tasks) {
    if (!task.done && task.assignee && openCounts.has(task.assignee)) {
      openCounts.set(task.assignee, openCounts.get(task.assignee)! + 1);
    }
  }
  return [...openCounts.entries()].map(([member, openTasks]) => ({ member, openTasks }));
}

// --------------------------------------------------------------------------
// Public store API — every function is scoped to one household by ID.
// --------------------------------------------------------------------------

export function getHousehold(householdId: string): Household {
  return loadHousehold(householdId);
}

export function listUpcomingTasks(householdId: string, withinDays: number): Task[] {
  const household = loadHousehold(householdId);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  return household.tasks
    .filter((t) => !t.done && new Date(t.dueDate) <= cutoff)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function listMembers(householdId: string): string[] {
  return loadHousehold(householdId).members;
}

export function suggestAssignee(householdId: string): string {
  return computeSuggestedAssignee(loadHousehold(householdId));
}

export function openTaskCounts(householdId: string): { member: string; openTasks: number }[] {
  return computeOpenTaskCounts(loadHousehold(householdId));
}

export function addTask(householdId: string, title: string, dueDate: string, assignee?: string): Task {
  const household = loadHousehold(householdId);
  const task: Task = {
    id: randomUUID(),
    title,
    dueDate,
    assignee: assignee ?? computeSuggestedAssignee(household),
    done: false,
  };
  household.tasks.push(task);
  saveHousehold(householdId, household);
  return task;
}

export interface ImportTaskInput {
  title: string;
  dueDate: string;
  assignee?: string;
}

/**
 * Adds many tasks in one household write instead of one file read+write per
 * task. Assignment is computed incrementally against the in-progress task
 * list (not just the on-disk snapshot) so a batch of unassigned tasks still
 * spreads fairly across members instead of piling onto whoever had the
 * fewest open tasks *before* the batch started.
 */
export function importTasks(householdId: string, items: ImportTaskInput[]): Task[] {
  const household = loadHousehold(householdId);
  const created: Task[] = [];
  for (const item of items) {
    const task: Task = {
      id: randomUUID(),
      title: item.title,
      dueDate: item.dueDate,
      assignee: item.assignee ?? computeSuggestedAssignee(household),
      done: false,
    };
    household.tasks.push(task);
    created.push(task);
  }
  if (created.length > 0) {
    saveHousehold(householdId, household);
  }
  return created;
}

export function markTaskDone(householdId: string, taskId: string): Task | undefined {
  const household = loadHousehold(householdId);
  const task = household.tasks.find((t) => t.id === taskId);
  if (task) {
    task.done = true;
    saveHousehold(householdId, household);
  }
  return task;
}

export function getTaskById(householdId: string, taskId: string): Task | undefined {
  return loadHousehold(householdId).tasks.find((t) => t.id === taskId);
}

export function listTaskIds(householdId: string): string[] {
  return loadHousehold(householdId).tasks.map((t) => t.id);
}

export function findItemByName(householdId: string, name: string): ShoppingItem | undefined {
  const needle = name.trim().toLowerCase();
  return loadHousehold(householdId).shoppingItems.find((i) => i.name.toLowerCase() === needle);
}

export function itemsRunningLow(householdId: string): ShoppingItem[] {
  return loadHousehold(householdId).shoppingItems.filter((i) => i.quantityOnHand <= i.reorderThreshold);
}

export function recordReorder(householdId: string, itemId: string): ShoppingItem | undefined {
  const household = loadHousehold(householdId);
  const item = household.shoppingItems.find((i) => i.id === itemId);
  if (item) {
    item.lastOrderedAt = new Date().toISOString().slice(0, 10);
    item.quantityOnHand += item.reorderThreshold + 1;
    saveHousehold(householdId, household);
  }
  return item;
}

// Caches the outcome of a spending action per household + item + idempotency
// key so a retried request (a flaky connection, an agent replaying an
// unacknowledged call) reorders at most once instead of double-spending.
// This cache is intentionally in-memory only (not persisted): it only needs
// to survive the lifetime of a retry window, not a server restart.
const reorderIdempotencyCache = new Map<string, ShoppingItem>();

export function recordReorderIdempotent(
  householdId: string,
  itemId: string,
  idempotencyKey?: string
): { item: ShoppingItem; replayed: boolean } | undefined {
  if (!idempotencyKey) {
    const item = recordReorder(householdId, itemId);
    return item && { item, replayed: false };
  }

  const cacheKey = `${householdId}:${itemId}:${idempotencyKey}`;
  const cached = reorderIdempotencyCache.get(cacheKey);
  if (cached) {
    return { item: cached, replayed: true };
  }

  const item = recordReorder(householdId, itemId);
  if (!item) return undefined;
  reorderIdempotencyCache.set(cacheKey, { ...item });
  return { item, replayed: false };
}

export function addExpense(householdId: string, description: string, amount: number, category: string): Expense {
  const household = loadHousehold(householdId);
  const expense: Expense = {
    id: randomUUID(),
    description,
    amount,
    category: category.toLowerCase(),
    loggedAt: new Date().toISOString().slice(0, 10),
  };
  household.expenses.push(expense);
  saveHousehold(householdId, household);
  return expense;
}

export function expensesThisWeek(householdId: string): Expense[] {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  return loadHousehold(householdId).expenses.filter((e) => new Date(e.loggedAt) >= weekAgo);
}

export function setBudget(householdId: string, category: string, amount: number): void {
  const household = loadHousehold(householdId);
  household.budgets[category.toLowerCase()] = amount;
  saveHousehold(householdId, household);
}

export function getBudgetStatus(householdId: string): BudgetStatus[] {
  const household = loadHousehold(householdId);
  const spentByCategory = new Map<string, number>();
  for (const e of expensesThisWeek(householdId)) {
    spentByCategory.set(e.category, (spentByCategory.get(e.category) ?? 0) + e.amount);
  }
  return Object.entries(household.budgets).map(([category, budget]) => {
    const spentThisWeek = spentByCategory.get(category) ?? 0;
    return {
      category,
      budget,
      spentThisWeek,
      remaining: budget - spentThisWeek,
      overBudget: spentThisWeek > budget,
    };
  });
}

export function getBudgetStatusFor(householdId: string, category: string): BudgetStatus | undefined {
  return getBudgetStatus(householdId).find((b) => b.category === category.toLowerCase());
}
