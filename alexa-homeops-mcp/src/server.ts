import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerShoppingTools } from "./tools/shopping.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { DEFAULT_HOUSEHOLD_ID } from "./store.js";

/**
 * Builds a fresh HomeOps MCP server instance scoped to one household. A new
 * instance is created per client session so Alexa+ (or any MCP client) can
 * hold an independent conversation without state leaking across sessions —
 * and, since every store call below is scoped by `householdId`, without one
 * household's data ever becoming visible to another's session either.
 *
 * `householdId` is resolved once, at session-initialize time, from the
 * caller's `Authorization: Bearer <token>` header (see src/auth.ts and
 * src/index.ts) and threaded through as a closure into every tool/resource
 * registration — the tools themselves never see the raw token, only the
 * household ID it resolved to.
 */
export function createHomeOpsServer(householdId: string = DEFAULT_HOUSEHOLD_ID): McpServer {
  const server = new McpServer(
    { name: "homeops-mcp", version: "0.3.0" },
    // Declaring the logging capability is what makes server.server.sendLoggingMessage(...)
    // actually emit notifications/message instead of silently no-op'ing.
    { capabilities: { logging: {} } }
  );

  const { notify } = registerResources(server, householdId);
  registerPrompts(server, householdId);

  registerTaskTools(server, notify, householdId);
  registerShoppingTools(server, notify, householdId);
  registerExpenseTools(server, notify, householdId);
  registerInsightTools(server, householdId);

  return server;
}
