import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

/**
 * Emits a structured `notifications/message` log entry (the MCP logging
 * capability) for a key household event — a task added, a budget exceeded,
 * a reorder confirmed, an elicitation declined. This is deliberately
 * separate from a tool call's own result: a client that has merely
 * subscribed to logs (no `logging/setLevel` call needed — the server sends
 * every level until a client asks it to filter) can observe these events
 * independent of which tool triggered them, e.g. for a live activity feed.
 *
 * A no-op (never throws) if the server hasn't declared the logging
 * capability, or no client is connected — logging is best-effort
 * observability, not something a tool's success should depend on.
 */
export async function logEvent(
  server: McpServer,
  level: LoggingLevel,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  try {
    await server.server.sendLoggingMessage({
      level,
      logger: "homeops",
      data: { message, ...data },
    });
  } catch {
    // No client connected, or the client hasn't kept the transport open —
    // never let a logging failure surface as a tool error.
  }
}
