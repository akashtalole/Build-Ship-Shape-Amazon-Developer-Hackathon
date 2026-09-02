/**
 * End-to-end smoke test: spins up the HomeOps MCP server on an ephemeral
 * port, connects a real MCP client over Streamable HTTP, and exercises the
 * household task, shopping, and expense tools. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHomeOpsServer } from "../src/server.js";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { AddressInfo } from "node:net";

async function main() {
  const app = express();
  app.use(express.json());

  const transports = new Map<string, StreamableHTTPServerTransport>();
  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    await createHomeOpsServer().connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);

  const client = new Client({ name: "homeops-smoke-test", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(baseUrl));

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, [
    "add_expense",
    "add_task",
    "get_weekly_summary",
    "list_low_stock_items",
    "list_upcoming_tasks",
    "mark_task_done",
    "reorder_item",
  ]);
  console.log("✓ all 7 HomeOps tools discoverable");

  const upcoming = await client.callTool({ name: "list_upcoming_tasks", arguments: { withinDays: 7 } });
  assert.equal(upcoming.isError, undefined);
  console.log("✓ list_upcoming_tasks:", (upcoming.content as any)[0].text.split("\n")[0]);

  const lowStock = await client.callTool({ name: "list_low_stock_items", arguments: {} });
  const lowStockText = (lowStock.content as any)[0].text as string;
  assert.match(lowStockText, /dog food/i);
  console.log("✓ list_low_stock_items flags dog food as low");

  const preview = await client.callTool({ name: "reorder_item", arguments: { itemName: "Dog food" } });
  const previewText = (preview.content as any)[0].text as string;
  assert.match(previewText, /Confirm the reorder/);
  console.log("✓ reorder_item previews without confirm=true");

  const confirmed = await client.callTool({
    name: "reorder_item",
    arguments: { itemName: "Dog food", confirm: true },
  });
  const confirmedText = (confirmed.content as any)[0].text as string;
  assert.match(confirmedText, /Reordered Dog food/);
  console.log("✓ reorder_item executes once confirmed");

  await client.callTool({
    name: "add_expense",
    arguments: { description: "Dog food restock", amount: 42.5, category: "pets" },
  });
  const summary = await client.callTool({ name: "get_weekly_summary", arguments: {} });
  const summaryText = (summary.content as any)[0].text as string;
  assert.match(summaryText, /pets: 42.50/);
  console.log("✓ get_weekly_summary reflects the logged expense");

  await client.close();
  httpServer.close();
  console.log("\nAll HomeOps MCP smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
