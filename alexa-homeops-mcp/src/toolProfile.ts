import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ToolProfile = "full" | "voice";

/**
 * The tools a household member would plausibly ask a voice assistant for.
 * Admin and setup tools (tokens, webhooks, bulk import, budgets, allowance
 * rules) stay in the "full" profile: every extra tool an agent has to choose
 * between makes it likelier to pick the wrong one mid-conversation.
 */
export const VOICE_PROFILE_TOOLS: ReadonlySet<string> = new Set([
  "run_morning_briefing",
  "capture_note",
  "list_upcoming_tasks",
  "add_task",
  "mark_task_done",
  "add_recurring_task",
  "list_low_stock_items",
  "reorder_item",
  "add_expense",
  "get_budget_status",
  "get_proactive_alerts",
  "suggest_meal_plan",
]);

export function resolveToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  return env.HOMEOPS_TOOL_PROFILE === "voice" ? "voice" : "full";
}

/** Must run before any tool registers, same as restrictToReadOnlyTools in rbac.ts. */
export function applyToolProfile(server: McpServer, profile: ToolProfile): void {
  if (profile === "full") return;

  const original = server.registerTool.bind(server);
  const filtered = (name: string, config: unknown, callback: unknown) => {
    const registered = original(name, config as never, callback as never);
    if (!VOICE_PROFILE_TOOLS.has(name)) registered.disable();
    return registered;
  };
  (server as unknown as { registerTool: typeof filtered }).registerTool = filtered;
}
