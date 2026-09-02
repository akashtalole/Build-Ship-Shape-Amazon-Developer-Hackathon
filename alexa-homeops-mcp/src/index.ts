import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createHomeOpsServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3333);

const app = express();
app.use(express.json());

// One Streamable HTTP transport per MCP session, per the MCP spec
// (2025-11-25+): a session is opened by an initialize request and reused
// for the lifetime of the conversation via the Mcp-Session-Id header.
const transports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    const server = createHomeOpsServer();
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
});
