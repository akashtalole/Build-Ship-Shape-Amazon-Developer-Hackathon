import { randomUUID } from "node:crypto";
import type { Expense, Household, ShoppingItem, Task } from "./types.js";

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

export function addTask(title: string, dueDate: string, assignee?: string): Task {
  const task: Task = { id: randomUUID(), title, dueDate, assignee, done: false };
  household.tasks.push(task);
  return task;
}

export function markTaskDone(taskId: string): Task | undefined {
  const task = household.tasks.find((t) => t.id === taskId);
  if (task) task.done = true;
  return task;
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

export function addExpense(description: string, amount: number, category: string): Expense {
  const expense: Expense = {
    id: randomUUID(),
    description,
    amount,
    category,
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
