import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBudgetStatus, itemsRunningLow, listUpcomingTasks } from "../store.js";

/**
 * Registers a tool that demonstrates MCP sampling: instead of shipping its
 * own LLM API key, the server asks the connected client (Alexa+'s own
 * model) to turn raw household data into a short natural-language digest.
 * If the client hasn't declared the sampling capability, this falls back to
 * a plain templated summary so the tool still works everywhere.
 */
export function registerInsightTools(server: McpServer): void {
  server.registerTool(
    "generate_weekly_narrative",
    {
      description:
        "Generate a short, natural-language weekly household digest (tasks, low stock, budget) " +
        "by asking the connected model to narrate the raw data, via MCP sampling.",
      inputSchema: {},
    },
    async () => {
      const tasks = listUpcomingTasks(7);
      const lowStock = itemsRunningLow();
      const budgets = getBudgetStatus();
      const facts = JSON.stringify({ tasks, lowStock, budgets }, null, 2);

      try {
        const result = await server.server.createMessage({
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  "Turn this household data into a warm, 2-3 sentence weekly digest. " +
                  `Only state facts present in the data, no invented details:\n\n${facts}`,
              },
            },
          ],
          maxTokens: 200,
        });

        const text =
          result.content.type === "text" ? result.content.text : "The model returned a non-text response.";
        return { content: [{ type: "text", text }] };
      } catch {
        // Client doesn't support sampling (capability not declared) — fall
        // back to a templated digest built directly from the same data.
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
    }
  );
}
