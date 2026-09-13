export interface RecurrenceRule {
  // 0 = Sunday .. 6 = Saturday (matches JS Date#getDay()).
  daysOfWeek: number[];
}

export interface Task {
  id: string;
  title: string;
  dueDate: string; // ISO date, e.g. "2026-09-05"
  assignee?: string;
  done: boolean;
  // Present only on a recurring *template* row (added via add_recurring_task).
  // A template is never itself returned by list_upcoming_tasks — its
  // occurrences are materialized on the fly instead (see store.ts).
  recurrence?: RecurrenceRule;
  // Optional per-task allowance reward (see set_task_reward / the
  // chore-to-allowance ledger). Awarded to `assignee` once, the moment the
  // task transitions to done via mark_task_done — never on a recurring
  // template's materialized occurrences, which have no persisted `done` state
  // to award against.
  rewardAmount?: number;
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

// A household's registered outbound alert callback (see webhookDelivery.ts).
// The secret is generated server-side and shown to the caller exactly once,
// at registration time, then stored here for signing future deliveries.
export interface AlertWebhookRegistration {
  url: string;
  secret: string;
  createdAt: string; // ISO timestamp
}

export interface Household {
  id: string;
  name: string;
  members: string[];
  tasks: Task[];
  shoppingItems: ShoppingItem[];
  expenses: Expense[];
  budgets: Record<string, number>; // category -> weekly budget
  alertWebhook?: AlertWebhookRegistration;
  // Chore-to-allowance ledger: each member's running, unpaid balance earned
  // by completing tasks that carry a rewardAmount (see set_task_reward).
  // Optional on the type (not every persisted household file predates this
  // round) — every store function that reads it defensively falls back to
  // an empty record rather than assuming it's present.
  allowanceBalances?: Record<string, number>;
}

// A bearer token now resolves to both a household and an access level (see
// src/auth.ts). "read-only" can call any read tool but is rejected by every
// write tool; "full-access" (the default, for backward compatibility with
// round 4's no-roles behavior) can call everything.
export type AccessRole = "full-access" | "read-only";

export interface BudgetStatus {
  category: string;
  budget: number;
  spentThisWeek: number;
  remaining: number;
  overBudget: boolean;
}
