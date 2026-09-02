import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBudgetStatus, itemsRunningLow, listUpcomingTasks, openTaskCounts, suggestAssignee } from "../store.js";

/**
 * Asks the connected client's model (via MCP sampling) to turn a prompt +
 * raw facts into natural language. Returns undefined if the client hasn't
 * declared the sampling capability, so callers can fall back gracefully
 * instead of erroring.
 */
async function sampleNarrative(server: McpServer, instruction: string, facts: unknown): Promise<string | undefined> {
  try {
    const result = await server.server.createMessage({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `${instruction}\n\n${JSON.stringify(facts, null, 2)}` },
        },
      ],
      maxTokens: 200,
    });
    return result.content.type === "text" ? result.content.text : undefined;
  } catch {
    return undefined;
  }
}

export function registerInsightTools(server: McpServer): void {
  server.registerTool(
    "generate_weekly_narrative",
    {
      description:
        "Generate a short, natural-language weekly household digest (tasks, low stock, budget) " +
        "by asking the connected model to narrate the raw data, via MCP sampling.",
      inputSchema: {},
      annotations: { title: "Generate weekly narrative", readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const tasks = listUpcomingTasks(7);
      const lowStock = itemsRunningLow();
      const budgets = getBudgetStatus();

      const narrated = await sampleNarrative(
        server,
        "Turn this household data into a warm, 2-3 sentence weekly digest. Only state facts present in the data, no invented details.",
        { tasks, lowStock, budgets }
      );
      if (narrated) {
        return { content: [{ type: "text", text: narrated }] };
      }

      // Client doesn't support sampling — fall back to a templated digest
      // built directly from the same data.
      const dueSoon = tasks.length ? `${tasks.length} task(s) due this week` : "nothing due this week";
      const stock = lowStock.length ? `${lowStock.map((i) => i.name).join(", ")} running low` : "everything stocked";
      const overBudget = budgets.filter((b) => b.overBudget);
      const spend = overBudget.length
        ? `over budget on ${overBudget.map((b) => b.category).join(", ")}`
        : "spending is on track";
      return {
        content: [
          {
            type: "text",
            text: `This week: ${dueSoon}, ${stock}, and ${spend}. (Templated digest — client has no sampling support.)`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "run_morning_briefing",
    {
      description:
        "A compound tool: chains today's tasks, chore-rotation suggestion, low-stock items, and budget " +
        "status into one call, then narrates them together. Prefer this over calling list_upcoming_tasks, " +
        "suggest_assignee, list_low_stock_items, and get_budget_status separately when the user asks for " +
        "an overview — it's one round trip instead of four, which matters for a voice interaction.",
      inputSchema: {},
      outputSchema: {
        tasksToday: z.array(
          z.object({ id: z.string(), title: z.string(), dueDate: z.string(), assignee: z.string().optional(), done: z.boolean() })
        ),
        suggestedAssignee: z.string(),
        lowStockCount: z.number(),
        overBudgetCategories: z.array(z.string()),
      },
      annotations: { title: "Run morning briefing", readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const tasksToday = listUpcomingTasks(1);
      const suggestedAssignee = suggestAssignee();
      const workload = openTaskCounts();
      const lowStock = itemsRunningLow();
      const budgets = getBudgetStatus();
      const overBudget = budgets.filter((b) => b.overBudget);

      const facts = { tasksToday, suggestedAssignee, workload, lowStock, budgets };
      const narrated = await sampleNarrative(
        server,
        "Give a warm 2-3 sentence good-morning household briefing: what's due today, who should take " +
          "the next chore, anything running low, and how spending compares to budget. Only use facts present " +
          "in the data below.",
        facts
      );

      const text =
        narrated ??
        [
          tasksToday.length ? `${tasksToday.length} task(s) due today` : "nothing due today",
          `${suggestedAssignee} is next up for chores`,
          lowStock.length ? `${lowStock.length} item(s) running low` : "shopping list is fine",
          overBudget.length ? `over budget on ${overBudget.map((b) => b.category).join(", ")}` : "spending on track",
        ].join(", ") + ". (Templated digest — client has no sampling support.)";

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          tasksToday,
          suggestedAssignee,
          lowStockCount: lowStock.length,
          overBudgetCategories: overBudget.map((b) => b.category),
        },
      };
    }
  );
}
