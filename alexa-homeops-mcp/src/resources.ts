import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getBudgetStatus, itemsRunningLow, listUpcomingTasks } from "./store.js";

export const RESOURCE_URIS = {
  upcomingTasks: "homeops://tasks/upcoming",
  lowStock: "homeops://shopping/low-stock",
  budgetStatus: "homeops://budget/status",
} as const;

export type NotifyFn = (uri: string) => Promise<void>;

/**
 * Registers HomeOps' live household state as MCP resources (not just tool
 * outputs) so a client can subscribe once and be pushed updates instead of
 * polling. Returns a `notify` function that tool handlers call after any
 * write that changes one of these resources.
 */
export function registerResources(server: McpServer): { notify: NotifyFn } {
  const subscriptions = new Set<string>();

  server.registerResource(
    "upcoming-tasks",
    RESOURCE_URIS.upcomingTasks,
    {
      title: "Upcoming household tasks",
      description: "Tasks due within the next 7 days, soonest first.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(listUpcomingTasks(7), null, 2) }],
    })
  );

  server.registerResource(
    "low-stock-items",
    RESOURCE_URIS.lowStock,
    {
      title: "Items running low",
      description: "Household shopping items at or below their reorder threshold.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(itemsRunningLow(), null, 2) }],
    })
  );

  server.registerResource(
    "budget-status",
    RESOURCE_URIS.budgetStatus,
    {
      title: "Weekly budget status",
      description: "Spend vs. budget per category for the current week.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(getBudgetStatus(), null, 2) }],
    })
  );

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  const notify: NotifyFn = async (uri) => {
    if (subscriptions.has(uri)) {
      await server.server.sendResourceUpdated({ uri });
    }
  };

  return { notify };
}
