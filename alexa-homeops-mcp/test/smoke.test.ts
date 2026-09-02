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
import { InMemoryEventStore } from "../src/eventStore.js";

function testEventStore() {
  const store = new InMemoryEventStore();
  return (async () => {
    const a1 = await store.storeEvent("stream-a", { jsonrpc: "2.0", method: "notifications/a1" } as any);
    const a2 = await store.storeEvent("stream-a", { jsonrpc: "2.0", method: "notifications/a2" } as any);
    await store.storeEvent("stream-b", { jsonrpc: "2.0", method: "notifications/b1" } as any); // different stream
    const a3 = await store.storeEvent("stream-a", { jsonrpc: "2.0", method: "notifications/a3" } as any);

    const replayed: string[] = [];
    const resumedStreamId = await store.replayEventsAfter(a1, {
      send: async (_id, message: any) => {
        replayed.push(message.method);
      },
    });
    assert.equal(resumedStreamId, "stream-a");
    assert.deepEqual(replayed, ["notifications/a2", "notifications/a3"]);

    const unknown = await store.replayEventsAfter("stream-a:not-a-real-id", { send: async () => {} });
    assert.equal(unknown, "stream-a"); // extraction still works; no matching event to replay past

    void a2;
  })();
}

async function main() {
  await testEventStore();
  console.log("✓ InMemoryEventStore replays only same-stream events strictly after the given event ID");

  const app = express();
  app.use(express.json());

  const eventStore = new InMemoryEventStore();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
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
    "run_morning_briefing",
    "set_budget",
    "suggest_assignee",
    "sync_household_calendar",
  ]);
  const listTasksTool = tools.tools.find((t) => t.name === "list_upcoming_tasks")!;
  assert.equal(listTasksTool.annotations?.readOnlyHint, true);
  const addTaskTool = tools.tools.find((t) => t.name === "add_task")!;
  assert.equal(addTaskTool.annotations?.readOnlyHint, false);
  console.log("✓ all 13 HomeOps tools discoverable, with read/write annotations");

  // --- Resources (static + a completable template) ---
  const resources = await client.listResources();
  const resourceUris = resources.resources.map((r) => r.uri).sort();
  assert.deepEqual(resourceUris, [
    "homeops://budget/status",
    "homeops://shopping/low-stock",
    "homeops://tasks/upcoming",
  ]);
  await client.subscribeResource({ uri: "homeops://tasks/upcoming" });

  const templates = await client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some((t) => t.uriTemplate === "homeops://tasks/{taskId}"));
  console.log("✓ resources listed and subscribable, task-detail template discoverable");

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

  // --- Structured tool output ---
  const listed = await client.callTool({ name: "list_upcoming_tasks", arguments: {} });
  assert.ok(Array.isArray((listed.structuredContent as any)?.tasks));
  console.log("✓ list_upcoming_tasks returns structuredContent alongside the text summary");

  // --- Resource template + argument completion ---
  const completion = await client.complete({
    ref: { type: "ref/resource", uri: "homeops://tasks/{taskId}" },
    argument: { name: "taskId", value: "" },
  });
  assert.ok(completion.completion.values.length > 0);
  const someTaskId = completion.completion.values[0];
  const taskResource = await client.readResource({ uri: `homeops://tasks/${someTaskId}` });
  assert.ok((taskResource.contents[0].text as string).includes(someTaskId));
  console.log("✓ homeops://tasks/{taskId} template resolves via completion + direct read");

  // --- Elicitation-backed reorder ---
  const reorder = await client.callTool({ name: "reorder_item", arguments: { itemName: "Dog food" } });
  const reorderText = (reorder.content as any)[0].text as string;
  assert.match(reorderText, /Reordered Dog food/);
  console.log("✓ reorder_item confirms via MCP elicitation, then executes");

  // --- Idempotency-key protected retry ---
  const extractQuantity = (text: string) => Number(text.match(/shows (\d+) on hand/)?.[1]);
  const paperTowelsKey = randomUUID();
  const firstAttempt = await client.callTool({
    name: "reorder_item",
    arguments: { itemName: "Paper towels", confirm: true, idempotencyKey: paperTowelsKey },
  });
  const retryAttempt = await client.callTool({
    name: "reorder_item",
    arguments: { itemName: "Paper towels", confirm: true, idempotencyKey: paperTowelsKey },
  });
  const freshReorder = await client.callTool({
    name: "reorder_item",
    arguments: { itemName: "Paper towels", confirm: true, idempotencyKey: randomUUID() },
  });
  assert.match((firstAttempt.content as any)[0].text, /Reordered Paper towels/);
  assert.match((retryAttempt.content as any)[0].text, /Already reordered/);
  const qtyAfterFirst = extractQuantity((firstAttempt.content as any)[0].text);
  const qtyAfterFresh = extractQuantity((freshReorder.content as any)[0].text);
  // Paper towels has reorderThreshold 2, so a real second reorder adds
  // exactly 3 more. If the retried (same-key) call had double-restocked,
  // this gap would be 6, not 3.
  assert.equal(qtyAfterFresh - qtyAfterFirst, 3);
  console.log("✓ reorder_item with a repeated idempotencyKey reorders exactly once, not twice");

  // --- Compound orchestration tool ---
  const briefing = await client.callTool({ name: "run_morning_briefing", arguments: {} });
  assert.equal((briefing.content as any)[0].text, "Mock digest: everything looks under control this week.");
  const briefingData = briefing.structuredContent as any;
  assert.ok(typeof briefingData.suggestedAssignee === "string");
  assert.ok(Array.isArray(briefingData.tasksToday));
  console.log("✓ run_morning_briefing chains tasks + assignment + stock + budget into one call");

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
  assert.ok(Array.isArray((budgetStatus.structuredContent as any)?.budgets));
  console.log("✓ get_budget_status surfaces the overage, with structured budgets[] alongside the text");

  // --- Sampling-backed narrative ---
  const narrative = await client.callTool({ name: "generate_weekly_narrative", arguments: {} });
  const narrativeText = (narrative.content as any)[0].text as string;
  assert.equal(narrativeText, "Mock digest: everything looks under control this week.");
  console.log("✓ generate_weekly_narrative uses MCP sampling against the client's model");

  // --- Progress notifications on a long-running tool ---
  const progressUpdates: number[] = [];
  await client.callTool(
    { name: "sync_household_calendar", arguments: {} },
    undefined,
    {
      onprogress: (p) => progressUpdates.push(p.progress),
    }
  );
  assert.ok(progressUpdates.length > 0);
  console.log(`✓ sync_household_calendar streamed ${progressUpdates.length} progress notification(s)`);

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
