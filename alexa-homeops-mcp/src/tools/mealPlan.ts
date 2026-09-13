import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMealPlan } from "../mealPlanner.js";

export function registerMealPlanTools(server: McpServer, householdId: string): void {
  server.registerTool(
    "suggest_meal_plan",
    {
      description:
        "Suggest a few days of meals by cross-referencing what's already running low (to use it up before " +
        "buying more), the household's remaining weekly groceries budget (to keep the plan affordable), and " +
        "upcoming tasks (a day with something due gets a quick meal instead of a long cook). Use this instead of " +
        "picking meals blind when the user asks 'what should we eat this week' or 'help me plan dinners'.",
      inputSchema: {
        days: z.number().int().min(1).max(7).default(3).describe("How many days to plan for (default 3)."),
      },
      outputSchema: {
        days: z.array(
          z.object({
            date: z.string(),
            meal: z.string(),
            quickMeal: z.boolean(),
            busyDay: z.boolean(),
            estCost: z.number(),
            usesLowStockItems: z.array(z.string()),
          })
        ),
        totalEstCost: z.number(),
        groceryBudgetRemaining: z.number().nullable(),
        withinBudget: z.boolean(),
        lowStockConsidered: z.array(z.string()),
        busyDayCount: z.number(),
      },
      annotations: { title: "Suggest meal plan", readOnlyHint: true, openWorldHint: false },
    },
    async ({ days }) => {
      const plan = buildMealPlan(householdId, days ?? 3);

      const lines = plan.days.map((d) => {
        const tags = [d.busyDay ? "busy day — quick meal" : undefined, d.usesLowStockItems.length ? `uses ${d.usesLowStockItems.join(", ")}` : undefined]
          .filter(Boolean)
          .join("; ");
        return `- ${d.date}: ${d.meal} (~${d.estCost.toFixed(2)})${tags ? ` [${tags}]` : ""}`;
      });

      const budgetLine =
        plan.groceryBudgetRemaining === null
          ? `No groceries budget set — estimated total: ${plan.totalEstCost.toFixed(2)}.`
          : `Estimated total ${plan.totalEstCost.toFixed(2)} against ${plan.groceryBudgetRemaining.toFixed(2)} remaining in the groceries budget` +
            (plan.withinBudget ? " — within budget." : " — this plan would go over; consider trimming a day.");

      const text = [`Meal plan for the next ${plan.days.length} day(s):`, ...lines, "", budgetLine].join("\n");

      return { content: [{ type: "text", text }], structuredContent: { ...plan } };
    }
  );
}
