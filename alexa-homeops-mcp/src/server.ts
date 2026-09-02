import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerShoppingTools } from "./tools/shopping.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

/**
 * Builds a fresh HomeOps MCP server instance. A new instance is created per
 * client session so Alexa+ (or any MCP client) can hold an independent
 * conversation without state leaking across sessions.
 */
export function createHomeOpsServer(): McpServer {
  const server = new McpServer({
    name: "homeops-mcp",
    version: "0.2.0",
  });

  const { notify } = registerResources(server);
  registerPrompts(server);

  registerTaskTools(server, notify);
  registerShoppingTools(server, notify);
  registerExpenseTools(server, notify);
  registerInsightTools(server);

  return server;
}
