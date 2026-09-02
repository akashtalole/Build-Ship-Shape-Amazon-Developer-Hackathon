/**
 * End-to-end smoke test: spins up the HomeOps MCP server on an ephemeral
 * port, connects a real MCP client over Streamable HTTP, and exercises
 * every capability — tools, resources (+ subscribe/notify), prompts,
 * elicitation, and sampling. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createHomeOpsServer } from "../src/server.js";

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

  const client = new Client(
    { name: "homeops-smoke-test", version: "0.1.0" },
    { capabilities: { elicitation: { form: {} }, sampling: {} } }
  );

  // Auto-accept any confirmation the server elicits.
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    return { action: "accept", content: { confirmReorder: true } };
  });

  // Mock the client-side "LLM" the server samples from.
  client.setRequestHandler(CreateMessageRequestSchema, async () => {
    return {
      role: "assistant",
      content: { type: "text", text: "Mock digest: everything looks under control this week." },
      model: "mock-model",
    };
  });

  let resourceUpdates = 0;
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => {
    resourceUpdates += 1;
  });

  await client.connect(new StreamableHTTPClientTransport(baseUrl));

  // --- Tools ---
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, [
    "add_expense",
    "add_task",
    "generate_weekly_narrative",
    "get_budget_status",
    "get_weekly_summary",
    "list_low_stock_items",
    "list_upcoming_tasks",
    "mark_task_done",
    "reorder_item",
    "set_budget",
    "suggest_assignee",
  ]);
  console.log("✓ all 11 HomeOps tools discoverable");

  // --- Resources ---
  const resources = await client.listResources();
  const resourceUris = resources.resources.map((r) => r.uri).sort();
  assert.deepEqual(resourceUris, [
    "homeops://budget/status",
    "homeops://shopping/low-stock",
    "homeops://tasks/upcoming",
  ]);
  await client.subscribeResource({ uri: "homeops://tasks/upcoming" });
  console.log("✓ resources listed and subscribable");

  // --- Prompts ---
  const prompt = await client.getPrompt({ name: "weekly_household_briefing", arguments: { tone: "concise" } });
  assert.ok(prompt.messages[0].content.type === "text");
  console.log("✓ weekly_household_briefing prompt renders");

  // --- Fair chore rotation ---
  const suggestion = await client.callTool({ name: "suggest_assignee", arguments: {} });
  console.log("✓ suggest_assignee:", (suggestion.content as any)[0].text);

  const added = await client.callTool({
    name: "add_task",
    arguments: { title: "Water the plants", dueDate: "2026-09-03" },
  });
  const addedText = (added.content as any)[0].text as string;
  assert.match(addedText, /auto-assigned by workload/);
  // Resource-updated notifications ride the SSE stream independently of the
  // tool call's response, so give one a moment to arrive before asserting.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(resourceUpdates > 0);
  console.log("✓ add_task auto-assigns via fair rotation and notifies the subscribed tasks resource");

  // --- Elicitation-backed reorder ---
  const reorder = await client.callTool({ name: "reorder_item", arguments: { itemName: "Dog food" } });
  const reorderText = (reorder.content as any)[0].text as string;
  assert.match(reorderText, /Reordered Dog food/);
  console.log("✓ reorder_item confirms via MCP elicitation, then executes");

  // --- Budgets ---
  await client.callTool({ name: "set_budget", arguments: { category: "pets", amount: 50 } });
  const expense = await client.callTool({
    name: "add_expense",
    arguments: { description: "Dog food restock", amount: 60, category: "pets" },
  });
  const expenseText = (expense.content as any)[0].text as string;
  assert.match(expenseText, /over its weekly budget/);
  console.log("✓ add_expense flags an over-budget category");

  const budgetStatus = await client.callTool({ name: "get_budget_status", arguments: {} });
  const budgetText = (budgetStatus.content as any)[0].text as string;
  assert.match(budgetText, /over budget/);
  console.log("✓ get_budget_status surfaces the overage");

  // --- Sampling-backed narrative ---
  const narrative = await client.callTool({ name: "generate_weekly_narrative", arguments: {} });
  const narrativeText = (narrative.content as any)[0].text as string;
  assert.equal(narrativeText, "Mock digest: everything looks under control this week.");
  console.log("✓ generate_weekly_narrative uses MCP sampling against the client's model");

  await client.close();
  httpServer.close();
  console.log("\nAll HomeOps MCP smoke tests passed.");
}

main()
  .catch((err) => {
    console.error("Smoke test failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Streamable HTTP keeps the SSE stream (and thus the event loop) open;
    // force-exit once the test has run to completion either way.
    process.exit(process.exitCode ?? 0);
  });
