import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBudgetStatus, itemsRunningLow, listUpcomingTasks, openTaskCounts, suggestAssignee } from "../store.js";
import { computeHouseholdAnomalies, type HouseholdAnomaly } from "../anomalies.js";
import { generateText } from "../llm.js";

const anomalyShape = {
  type: z.enum(["task_pileup", "spending_trend", "stale_low_stock"]),
  severity: z.enum(["notice", "warning"]),
  message: z.string(),
  data: z.record(z.unknown()),
};

function formatAnomalies(anomalies: HouseholdAnomaly[]): string[] {
  return anomalies.map((a) => `  - [${a.severity}] ${a.message}`);
}

async function sampleNarrative(server: McpServer, instruction: string, facts: unknown): Promise<string | undefined> {
  const generated = await generateText(server, `${instruction}\n\n${JSON.stringify(facts, null, 2)}`);
  return generated?.text;
}

export function registerInsightTools(server: McpServer, householdId: string): void {
  server.registerTool(
    "generate_weekly_narrative",
    {
      description:
        "Generate a short, natural-language weekly household digest (tasks, low stock, budget) " +
        "by asking a language model to narrate the raw data: the connected client's own model via MCP sampling, " +
        "or Claude on Amazon Bedrock when the client doesn't support sampling.",
      inputSchema: {},
      annotations: { title: "Generate weekly narrative", readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const tasks = listUpcomingTasks(householdId, 7);
      const lowStock = itemsRunningLow(householdId);
      const budgets = getBudgetStatus(householdId);

      const narrated = await sampleNarrative(
        server,
        "Turn this household data into a warm, 2-3 sentence weekly digest. Only state facts present in the data, no invented details.",
        { tasks, lowStock, budgets }
      );
      if (narrated) {
        return { content: [{ type: "text", text: narrated }] };
      }

      // No model available — fall back to a templated digest built directly
      // from the same data.
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
            text: `This week: ${dueSoon}, ${stock}, and ${spend}. (Templated digest — no language model available.)`,
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
      const tasksToday = listUpcomingTasks(householdId, 1);
      const suggestedAssignee = suggestAssignee(householdId);
      const workload = openTaskCounts(householdId);
      const lowStock = itemsRunningLow(householdId);
      const budgets = getBudgetStatus(householdId);
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
        ].join(", ") + ". (Templated digest — no language model available.)";

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

  server.registerTool(
    "get_proactive_alerts",
    {
      description:
        "Proactively surface things worth attention that nobody explicitly asked about: a task pileup on one " +
        "household member relative to others, a spending category trending toward going over its weekly budget " +
        "(not just already over it), or a low-stock item that's been sitting stale for a while without being " +
        "reordered. Use this for 'is anything I should know about' rather than a specific direct question, or " +
        "run it periodically to catch problems before they compound.",
      inputSchema: {},
      outputSchema: { anomalies: z.array(z.object(anomalyShape)), count: z.number() },
      annotations: { title: "Get proactive alerts", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const anomalies = computeHouseholdAnomalies(householdId);
      const text =
        anomalies.length === 0
          ? "Nothing stands out right now — no task pileup, budget categories are on a reasonable pace, and nothing's been low for long."
          : `${anomalies.length} thing(s) worth a look:\n${formatAnomalies(anomalies).join("\n")}`;
      return { content: [{ type: "text", text }], structuredContent: { anomalies, count: anomalies.length } };
    }
  );

  server.registerTool(
    "export_household_digest",
    {
      description:
        "Export one combined household digest report — upcoming tasks, budget status, low-stock items, and " +
        "proactive anomaly flags (task pileup, a spending category trending over budget, stale low-stock items) " +
        "— as a single text report a household member can read at a glance, or save/share/print. Reuses the " +
        "same model-backed narrative as generate_weekly_narrative for the summary paragraph (falling back " +
        "to a templated one if no model is available), and the same anomaly detection as " +
        "get_proactive_alerts, rather than duplicating either.",
      inputSchema: {
        withinDays: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(7)
          .describe("Task window to include in the digest, in days (default 7)."),
      },
      outputSchema: {
        generatedAt: z.string(),
        narrative: z.string(),
        tasks: z.array(
          z.object({ id: z.string(), title: z.string(), dueDate: z.string(), assignee: z.string().optional(), done: z.boolean() })
        ),
        budgets: z.array(
          z.object({
            category: z.string(),
            budget: z.number(),
            spentThisWeek: z.number(),
            remaining: z.number(),
            overBudget: z.boolean(),
          })
        ),
        lowStockItems: z.array(
          z.object({ id: z.string(), name: z.string(), quantityOnHand: z.number(), reorderThreshold: z.number() })
        ),
        anomalies: z.array(z.object(anomalyShape)),
      },
      annotations: { title: "Export household digest", readOnlyHint: true, openWorldHint: true },
    },
    async ({ withinDays }) => {
      const generatedAt = new Date().toISOString();
      const tasks = listUpcomingTasks(householdId, withinDays);
      const budgets = getBudgetStatus(householdId);
      const lowStock = itemsRunningLow(householdId);
      const overBudget = budgets.filter((b) => b.overBudget);
      const anomalies = computeHouseholdAnomalies(householdId);

      const narrated = await sampleNarrative(
        server,
        "Write a short 2-3 sentence household digest summary covering tasks due, low-stock items, and budget " +
          "status. Only state facts present in the data below, no invented details.",
        { tasks, budgets, lowStock }
      );
      const narrative =
        narrated ??
        `${tasks.length} task(s) due in the next ${withinDays} day(s), ${lowStock.length} item(s) running low, ` +
          `${overBudget.length} categor${overBudget.length === 1 ? "y" : "ies"} over budget. ` +
          `(Templated summary — no language model available.)`;

      const reportLines = [
        `HOUSEHOLD DIGEST — generated ${generatedAt}`,
        "=".repeat(48),
        "",
        "SUMMARY",
        narrative,
        "",
        `TASKS DUE (next ${withinDays} day(s))`,
        tasks.length
          ? tasks
              .map((t) => `  - [${t.dueDate}] ${t.title}${t.assignee ? ` (${t.assignee})` : ""}${t.done ? " [done]" : ""}`)
              .join("\n")
          : "  Nothing due.",
        "",
        "BUDGET STATUS",
        budgets.length
          ? budgets
              .map(
                (b) =>
                  `  - ${b.category}: ${b.spentThisWeek.toFixed(2)} / ${b.budget.toFixed(2)}` +
                  (b.overBudget ? " (OVER BUDGET)" : "")
              )
              .join("\n")
          : "  No budgets set.",
        "",
        "LOW STOCK",
        lowStock.length
          ? lowStock.map((i) => `  - ${i.name} (${i.quantityOnHand} on hand, reorder threshold ${i.reorderThreshold})`).join("\n")
          : "  Everything is well stocked.",
        "",
        "WORTH ATTENTION",
        anomalies.length ? formatAnomalies(anomalies).join("\n") : "  Nothing flagged.",
      ];

      return {
        content: [{ type: "text", text: reportLines.join("\n") }],
        structuredContent: { generatedAt, narrative, tasks, budgets, lowStockItems: lowStock, anomalies },
      };
    }
  );
}
