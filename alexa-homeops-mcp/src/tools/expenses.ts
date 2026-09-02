import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addExpense, expensesThisWeek } from "../store.js";

export function registerExpenseTools(server: McpServer): void {
  server.registerTool(
    "add_expense",
    {
      description: "Log a household expense with an amount and category.",
      inputSchema: {
        description: z.string().min(1).describe("What the expense was for."),
        amount: z.number().positive().describe("Amount spent, in the household's local currency."),
        category: z
          .string()
          .min(1)
          .describe("Category, e.g. 'groceries', 'utilities', 'maintenance'."),
      },
    },
    async ({ description, amount, category }) => {
      const expense = addExpense(description, amount, category);
      return {
        content: [
          {
            type: "text",
            text: `Logged ${expense.amount} for "${expense.description}" under ${expense.category}.`,
          },
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
}
