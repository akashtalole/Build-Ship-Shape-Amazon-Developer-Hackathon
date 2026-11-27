import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerShoppingTools } from "./tools/shopping.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerAccessTools } from "./tools/access.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { registerAllowanceTools } from "./tools/allowance.js";
import { registerMealPlanTools } from "./tools/mealPlan.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { restrictToReadOnlyTools } from "./rbac.js";
import { applyToolProfile, type ToolProfile } from "./toolProfile.js";
import { DEFAULT_HOUSEHOLD_ID } from "./store.js";
import type { AccessRole } from "./types.js";

/**
 * Builds a fresh HomeOps MCP server instance scoped to one household. A new
 * instance is created per client session so Alexa+ (or any MCP client) can
 * hold an independent conversation without state leaking across sessions —
 * and, since every store call below is scoped by `householdId`, without one
 * household's data ever becoming visible to another's session either.
 *
 * `householdId` and `role` are resolved once, at session-initialize time,
 * from the caller's `Authorization: Bearer <token>` header (see src/auth.ts
 * and src/index.ts) and threaded through — `householdId` as a closure into
 * every tool/resource registration, `role` by wrapping the server's own
 * `registerTool` before anything else registers with it (see src/rbac.ts) —
 * so the tools themselves never see the raw token, only the household ID
 * and access role it resolved to.
 */
export function createHomeOpsServer(
  householdId: string = DEFAULT_HOUSEHOLD_ID,
  role: AccessRole = "full-access",
  profile: ToolProfile = "full"
): McpServer {
  const server = new McpServer(
    { name: "homeops-mcp", version: "0.6.0" },
    // Declaring the logging capability is what makes server.server.sendLoggingMessage(...)
    // actually emit notifications/message instead of silently no-op'ing.
    { capabilities: { logging: {} } }
  );

  applyToolProfile(server, profile);

  // Must happen before any tool is registered below: it wraps
  // server.registerTool itself, so every subsequent registerTool call
  // (from every tools/*.ts module) picks up the wrapped version.
  if (role === "read-only") {
    restrictToReadOnlyTools(server);
  }

  const { notify } = registerResources(server, householdId);
  registerPrompts(server, householdId);

  registerTaskTools(server, notify, householdId);
  registerShoppingTools(server, notify, householdId);
  registerExpenseTools(server, notify, householdId);
  registerInsightTools(server, householdId);
  registerAccessTools(server, householdId);
  registerWebhookTools(server, householdId);
  registerAllowanceTools(server, householdId);
  registerMealPlanTools(server, householdId);
  registerCaptureTools(server, notify, householdId);

  return server;
}
