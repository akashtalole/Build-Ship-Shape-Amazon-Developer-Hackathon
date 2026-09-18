import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Downgrades every *write* tool a read-only session tries to register into
 * one that immediately rejects with a clear error, without touching a
 * single line inside tools/tasks.ts, tools/shopping.ts, etc.
 *
 * This works by reusing a distinction those tool files already make for an
 * unrelated reason: every tool registered anywhere in this server already
 * declares `annotations.readOnlyHint` (added in round 2, for clients to
 * decide what's safe to auto-approve). Rather than hand-adding a role check
 * inside every write tool's handler — `add_task`, `reorder_item`,
 * `add_expense`, `import_tasks`, `add_recurring_task`, `register_alert_webhook`,
 * `issue_household_token`, and any future one — this wraps `McpServer#registerTool`
 * itself, once, at session-creation time: a tool registered with
 * `readOnlyHint !== true` gets its handler swapped for a rejection before it
 * ever reaches `store.ts`. `readOnlyHint: true` tools (list/get/status/export)
 * are registered completely unchanged.
 *
 * Only called for `role === "read-only"` sessions (see server.ts) — a
 * full-access session's `McpServer` is never wrapped at all, so there is
 * zero behavior change (and zero overhead) on the default path.
 */
export function restrictToReadOnlyTools(server: McpServer): void {
  const original = server.registerTool.bind(server);

  const guarded = (name: string, config: unknown, callback: unknown) => {
    const isReadOnly = (config as { annotations?: { readOnlyHint?: boolean } } | null)?.annotations?.readOnlyHint === true;
    if (isReadOnly) {
      return original(name, config as never, callback as never);
    }

    const rejection = async () => ({
      content: [
        {
          type: "text" as const,
          text: `"${name}" is a write operation. This session's bearer token is read-only and cannot perform it — reconnect with a full-access token (see issue_household_token) to make changes.`,
        },
      ],
      isError: true,
    });
    return original(name, config as never, rejection as never);
  };

  (server as unknown as { registerTool: typeof guarded }).registerTool = guarded;
}
