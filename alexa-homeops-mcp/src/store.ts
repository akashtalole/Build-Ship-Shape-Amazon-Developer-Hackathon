import { randomUUID } from "node:crypto";
import type { BudgetStatus, Expense, Household, ShoppingItem, Task } from "./types.js";

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Single demo household, in-memory only. A production build would replace
// this with a per-user datastore keyed by the caller's identity.
const household: Household = {
  id: "home-1",
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

export function getHousehold(): Household {
  return household;
}

export function listUpcomingTasks(withinDays: number): Task[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  return household.tasks
    .filter((t) => !t.done && new Date(t.dueDate) <= cutoff)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function listMembers(): string[] {
  return household.members;
}

/**
 * Picks the household member with the fewest open (not-done) tasks, so
 * chores get distributed fairly instead of always landing on whoever is
 * asked first. Ties break in favor of whoever appears first in the
 * household's member list.
 */
export function suggestAssignee(): string {
  const openCounts = new Map(household.members.map((m) => [m, 0]));
  for (const task of household.tasks) {
    if (!task.done && task.assignee && openCounts.has(task.assignee)) {
      openCounts.set(task.assignee, openCounts.get(task.assignee)! + 1);
    }
  }
  return [...openCounts.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

export function openTaskCounts(): { member: string; openTasks: number }[] {
  const openCounts = new Map(household.members.map((m) => [m, 0]));
  for (const task of household.tasks) {
    if (!task.done && task.assignee && openCounts.has(task.assignee)) {
      openCounts.set(task.assignee, openCounts.get(task.assignee)! + 1);
    }
  }
  return [...openCounts.entries()].map(([member, openTasks]) => ({ member, openTasks }));
}

export function addTask(title: string, dueDate: string, assignee?: string): Task {
  const task: Task = { id: randomUUID(), title, dueDate, assignee: assignee ?? suggestAssignee(), done: false };
  household.tasks.push(task);
  return task;
}

export function markTaskDone(taskId: string): Task | undefined {
  const task = household.tasks.find((t) => t.id === taskId);
  if (task) task.done = true;
  return task;
}

export function getTaskById(taskId: string): Task | undefined {
  return household.tasks.find((t) => t.id === taskId);
}

export function listTaskIds(): string[] {
  return household.tasks.map((t) => t.id);
}

export function findItemByName(name: string): ShoppingItem | undefined {
  const needle = name.trim().toLowerCase();
  return household.shoppingItems.find((i) => i.name.toLowerCase() === needle);
}

export function itemsRunningLow(): ShoppingItem[] {
  return household.shoppingItems.filter((i) => i.quantityOnHand <= i.reorderThreshold);
}

export function recordReorder(itemId: string): ShoppingItem | undefined {
  const item = household.shoppingItems.find((i) => i.id === itemId);
  if (item) {
    item.lastOrderedAt = new Date().toISOString().slice(0, 10);
    item.quantityOnHand += item.reorderThreshold + 1;
  }
  return item;
}

// Caches the outcome of a spending action per idempotency key so a retried
// request (a flaky connection, an agent replaying an unacknowledged call)
// reorders at most once instead of double-spending. Keyed by item + caller
// key so different items don't collide on the same key.
const reorderIdempotencyCache = new Map<string, ShoppingItem>();

export function recordReorderIdempotent(
  itemId: string,
  idempotencyKey?: string
): { item: ShoppingItem; replayed: boolean } | undefined {
  if (!idempotencyKey) {
    const item = recordReorder(itemId);
    return item && { item, replayed: false };
  }

  const cacheKey = `${itemId}:${idempotencyKey}`;
  const cached = reorderIdempotencyCache.get(cacheKey);
  if (cached) {
    return { item: cached, replayed: true };
  }

  const item = recordReorder(itemId);
  if (!item) return undefined;
  reorderIdempotencyCache.set(cacheKey, { ...item });
  return { item, replayed: false };
}

export function addExpense(description: string, amount: number, category: string): Expense {
  const expense: Expense = {
    id: randomUUID(),
    description,
    amount,
    category: category.toLowerCase(),
    loggedAt: new Date().toISOString().slice(0, 10),
  };
  household.expenses.push(expense);
  return expense;
}

export function expensesThisWeek(): Expense[] {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  return household.expenses.filter((e) => new Date(e.loggedAt) >= weekAgo);
}

export function setBudget(category: string, amount: number): void {
  household.budgets[category.toLowerCase()] = amount;
}

export function getBudgetStatus(): BudgetStatus[] {
  const spentByCategory = new Map<string, number>();
  for (const e of expensesThisWeek()) {
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

export function getBudgetStatusFor(category: string): BudgetStatus | undefined {
  return getBudgetStatus().find((b) => b.category === category.toLowerCase());
}
