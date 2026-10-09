import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createHomeOpsServer } from "./server.js";
import { InMemoryEventStore } from "./eventStore.js";
import { extractBearerToken, resolveAccess } from "./auth.js";
import { configureTextModelFromEnv } from "./llm.js";
import { resolveToolProfile } from "./toolProfile.js";

const PORT = Number(process.env.PORT ?? 3333);
const textModel = configureTextModelFromEnv();
const toolProfile = resolveToolProfile();

const app = express();
app.use(express.json());

// One Streamable HTTP transport per MCP session, per the MCP spec
// (2025-11-25+): a session is opened by an initialize request and reused
// for the lifetime of the conversation via the Mcp-Session-Id header.
const transports = new Map<string, StreamableHTTPServerTransport>();

// Shared across sessions so a dropped-then-resumed connection can replay
// missed messages even though it gets a fresh transport instance.
const eventStore = new InMemoryEventStore();

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    // Resolve the household (and access role) for this session from its
    // Authorization header, once, at session-initialize time. MCP tool
    // handlers don't get raw HTTP headers, so this is the one place they're
    // read — the resulting householdId/role are then closed over by (or
    // wrapped around) every tool/resource this session's McpServer
    // registers, giving each distinct bearer token (or none) its own
    // isolated household, with no pre-registration required for a plain
    // full-access token (see src/auth.ts's resolveAccess).
    const token = extractBearerToken(req);
    const { householdId, role } = resolveAccess(token);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    const server = createHomeOpsServer(householdId, role, toolProfile);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: Mcp-Session-Id header required" },
    id: null,
  });
}

app.post("/mcp", handleMcpRequest);
app.get("/mcp", handleMcpRequest);
app.delete("/mcp", handleMcpRequest);

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", activeSessions: transports.size });
});

app.listen(PORT, () => {
  console.log(`HomeOps MCP server listening on http://localhost:${PORT}/mcp`);
  console.log(`Tool profile: ${toolProfile}; Bedrock fallback model: ${textModel ? textModel.model : "disabled"}`);
});
