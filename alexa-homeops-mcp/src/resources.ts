import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getBudgetStatus, getTaskById, itemsRunningLow, listTaskIds, listUpcomingTasks } from "./store.js";

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
 *
 * Scoped to a single household (`householdId`, resolved from the session's
 * bearer token — see src/auth.ts) so a resource read only ever reflects that
 * caller's own data.
 */
export function registerResources(server: McpServer, householdId: string): { notify: NotifyFn } {
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
      contents: [{ uri: uri.href, text: JSON.stringify(listUpcomingTasks(householdId, 7), null, 2) }],
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
      contents: [{ uri: uri.href, text: JSON.stringify(itemsRunningLow(householdId), null, 2) }],
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
      contents: [{ uri: uri.href, text: JSON.stringify(getBudgetStatus(householdId), null, 2) }],
    })
  );

  // A resource *template* (as opposed to the three static resources above)
  // exposes one resource per task, with tab-completion over current task
  // IDs so a client doesn't have to guess a valid `taskId`.
  server.registerResource(
    "task-detail",
    new ResourceTemplate("homeops://tasks/{taskId}", {
      list: undefined,
      complete: {
        taskId: (partial) => listTaskIds(householdId).filter((id) => id.startsWith(partial)),
      },
    }),
    {
      title: "Task detail",
      description: "A single household task by ID.",
      mimeType: "application/json",
    },
    async (uri, { taskId }) => {
      const task = getTaskById(householdId, String(taskId));
      if (!task) {
        throw new Error(`No task found with ID ${taskId}`);
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(task, null, 2) }] };
    }
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
