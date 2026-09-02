export interface Task {
  id: string;
  title: string;
  dueDate: string; // ISO date, e.g. "2026-09-05"
  assignee?: string;
  done: boolean;
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantityOnHand: number;
  reorderThreshold: number;
  lastOrderedAt?: string; // ISO date
}

export interface Expense {
  id: string;
  description: string;
  amount: number;
  category: string;
  loggedAt: string; // ISO date
}

export interface Household {
  id: string;
  name: string;
  members: string[];
  tasks: Task[];
  shoppingItems: ShoppingItem[];
  expenses: Expense[];
  budgets: Record<string, number>; // category -> weekly budget
}

export interface BudgetStatus {
  category: string;
  budget: number;
  spentThisWeek: number;
  remaining: number;
  overBudget: boolean;
}
