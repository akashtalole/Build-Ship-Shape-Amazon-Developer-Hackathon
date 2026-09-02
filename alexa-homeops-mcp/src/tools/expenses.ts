import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addExpense, expensesThisWeek, getBudgetStatus, setBudget } from "../store.js";
import { RESOURCE_URIS, type NotifyFn } from "../resources.js";

const budgetStatusShape = {
  category: z.string(),
  budget: z.number(),
  spentThisWeek: z.number(),
  remaining: z.number(),
  overBudget: z.boolean(),
};

export function registerExpenseTools(server: McpServer, notify: NotifyFn): void {
  server.registerTool(
    "add_expense",
    {
      description:
        "Log a household expense with an amount and category. Warns if this pushes the " +
        "category over its weekly budget (see set_budget / get_budget_status).",
      inputSchema: {
        description: z.string().min(1).describe("What the expense was for."),
        amount: z.number().positive().describe("Amount spent, in the household's local currency."),
        category: z
          .string()
          .min(1)
          .describe("Category, e.g. 'groceries', 'utilities', 'maintenance'."),
      },
      annotations: { title: "Add expense", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ description, amount, category }) => {
      const expense = addExpense(description, amount, category);
      await notify(RESOURCE_URIS.budgetStatus);

      const status = getBudgetStatus().find((b) => b.category === expense.category);
      const warning =
        status?.overBudget
          ? ` Heads up: ${status.category} is now ${(status.spentThisWeek - status.budget).toFixed(2)} over its weekly budget of ${status.budget}.`
          : "";

      return {
        content: [
          { type: "text", text: `Logged ${expense.amount} for "${expense.description}" under ${expense.category}.${warning}` },
        ],
      };
    }
  );

  server.registerTool(
    "get_weekly_summary",
    {
      description:
        "Summarize household activity for the past week: total spend by category. " +
        "Use this to answer 'how are we doing this week' or 'what have we spent on'.",
      inputSchema: {},
      annotations: { title: "Get weekly summary", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const expenses = expensesThisWeek();
      if (expenses.length === 0) {
        return { content: [{ type: "text", text: "No expenses logged in the past week." }] };
      }
      const totalsByCategory = new Map<string, number>();
      for (const e of expenses) {
        totalsByCategory.set(e.category, (totalsByCategory.get(e.category) ?? 0) + e.amount);
      }
      const total = expenses.reduce((sum, e) => sum + e.amount, 0);
      const lines = [...totalsByCategory.entries()].map(([category, sum]) => `- ${category}: ${sum.toFixed(2)}`);
      return {
        content: [{ type: "text", text: `Total spent this week: ${total.toFixed(2)}\n${lines.join("\n")}` }],
      };
    }
  );

  server.registerTool(
    "set_budget",
    {
      description: "Set (or update) the weekly budget for a spending category.",
      inputSchema: {
        category: z.string().min(1).describe("Category to budget, e.g. 'groceries'."),
        amount: z.number().nonnegative().describe("Weekly budget amount for that category."),
      },
      annotations: { title: "Set budget", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ category, amount }) => {
      setBudget(category, amount);
      await notify(RESOURCE_URIS.budgetStatus);
      return { content: [{ type: "text", text: `Set the weekly ${category.toLowerCase()} budget to ${amount}.` }] };
    }
  );

  server.registerTool(
    "get_budget_status",
    {
      description: "Show spend vs. budget for every tracked category this week, flagging anything over budget.",
      inputSchema: {},
      outputSchema: { budgets: z.array(z.object(budgetStatusShape)) },
      annotations: { title: "Get budget status", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const statuses = getBudgetStatus();
      const text =
        statuses.length === 0
          ? "No budgets set yet. Use set_budget to add one."
          : statuses
              .map(
                (b) =>
                  `- ${b.category}: ${b.spentThisWeek.toFixed(2)} / ${b.budget.toFixed(2)}` +
                  (b.overBudget ? " ⚠️ over budget" : "")
              )
              .join("\n");
      return { content: [{ type: "text", text }], structuredContent: { budgets: statuses } };
    }
  );
}
