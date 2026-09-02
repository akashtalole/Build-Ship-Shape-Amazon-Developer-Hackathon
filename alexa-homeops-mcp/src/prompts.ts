import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBudgetStatus, itemsRunningLow, listUpcomingTasks, openTaskCounts } from "./store.js";

/**
 * Registers a reusable prompt template so Alexa+ (or any MCP client) can pull
 * a ready-made "give me the household briefing" prompt instead of every
 * client having to hand-craft one from raw tool output.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "weekly_household_briefing",
    {
      title: "Weekly household briefing",
      description: "A ready-to-run prompt that turns current household data into a short spoken-style briefing.",
      argsSchema: {
        tone: z
          .enum(["friendly", "concise", "encouraging"])
          .default("friendly")
          .describe("Tone for the generated briefing."),
      },
    },
    ({ tone }) => {
      const tasks = listUpcomingTasks(7);
      const lowStock = itemsRunningLow();
      const budgets = getBudgetStatus();
      const workload = openTaskCounts();

      const context = JSON.stringify({ tasks, lowStock, budgets, workload }, null, 2);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `You are Alexa+ giving a household its weekly briefing in a ${tone} tone. ` +
                `Using only the JSON data below, summarize in 3-5 short sentences: what's due soon, ` +
                `anything running low worth reordering, and how spending compares to budget. ` +
                `Do not invent facts not present in the data.\n\n${context}`,
            },
          },
        ],
      };
    }
  );
}
