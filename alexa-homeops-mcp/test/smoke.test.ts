/**
 * End-to-end smoke test: spins up the HomeOps MCP server on an ephemeral
 * port, connects a real MCP client over Streamable HTTP, and exercises
 * every capability — tools, resources (+ subscribe/notify), prompts,
 * elicitation, sampling, bearer-token multi-tenancy, structured logging,
 * file-backed persistence across a simulated restart, bulk task import,
 * role-based access control, outbound alert webhooks (HMAC-signed, against
 * a real local HTTP listener), recurring tasks, and the household digest
 * export. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createHomeOpsServer } from "../src/server.js";
import { InMemoryEventStore } from "../src/eventStore.js";
import { extractBearerToken, resolveAccess } from "../src/auth.js";

// Isolate this test run's persisted household data from real usage and from
// any previous test run, and confirm it before any server/store code (which
// reads this env var lazily, not at import time) actually runs.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "homeops-smoke-"));
process.env.HOMEOPS_DATA_DIR = dataDir;

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

/**
 * Starts a fresh Express app + Streamable HTTP transport layer on an
 * ephemeral port, mirroring src/index.ts's session/auth wiring exactly
 * (bearer token → household ID → one McpServer per session) so the smoke
 * test exercises the real multi-tenancy path rather than a shortcut.
 */
function startServer(): { httpServer: HttpServer; baseUrl: URL } {
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

    const token = extractBearerToken(req);
    const { householdId, role } = resolveAccess(token);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    await createHomeOpsServer(householdId, role).connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  return { httpServer, baseUrl: new URL(`http://127.0.0.1:${port}/mcp`) };
}

/**
 * A tiny plain-`http` local listener standing in for a household's
 * registered alert-webhook endpoint — captures the raw body (needed to
 * independently recompute the HMAC signature) and headers of every POST it
 * receives, and always answers 200 so delivery succeeds on the first try.
 */
async function startWebhookListener(): Promise<{
  url: string;
  close: () => void;
  received: () => { body: string; headers: http.IncomingHttpHeaders }[];
}> {
  const received: { body: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf-8"), headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    close: () => server.close(),
    received: () => received,
  };
}

/** Connects an MCP client (with elicitation/sampling stubs wired in), optionally under a bearer token. */
async function connectClient(baseUrl: URL, token?: string) {
  const client = new Client(
    { name: "homeops-smoke-test", version: "0.1.0" },
    { capabilities: { elicitation: { form: {} }, sampling: {} } }
  );

  // Auto-accept any confirmation the server elicits.
  client.setRequestHandler(ElicitRequestSchema, async () => {
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

  const resourceUpdates: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
    resourceUpdates.push(n.params.uri);
  });

  const logMessages: { level: string; data: unknown }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
    logMessages.push({ level: n.params.level, data: n.params.data });
  });

  await client.connect(
    new StreamableHTTPClientTransport(baseUrl, token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined)
  );

  return { client, resourceUpdates, logMessages };
}

async function main() {
  await testEventStore();
  console.log("✓ InMemoryEventStore replays only same-stream events strictly after the given event ID");

  const { httpServer, baseUrl } = startServer();
  const { client, resourceUpdates, logMessages } = await connectClient(baseUrl);

  // --- Tools ---
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, [
    "add_expense",
    "add_recurring_task",
    "add_task",
    "export_household_digest",
    "generate_weekly_narrative",
    "get_alert_webhook_status",
    "get_budget_status",
    "get_weekly_summary",
    "import_tasks",
    "issue_household_token",
    "list_low_stock_items",
    "list_upcoming_tasks",
    "mark_task_done",
    "register_alert_webhook",
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
  console.log(`✓ all ${toolNames.length} HomeOps tools discoverable, with read/write annotations`);

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
  assert.ok(resourceUpdates.length > 0);
  console.log("✓ add_task auto-assigns via fair rotation and notifies the subscribed tasks resource");

  // --- Structured logging (MCP logging capability) ---
  // add_task above should have already fired a "Task added" notifications/message,
  // independent of and in addition to the tool's own text result.
  assert.ok(logMessages.length > 0, "expected at least one notifications/message log entry");
  assert.ok(
    logMessages.some((m) => (m.data as any)?.message === "Task added"),
    "expected a 'Task added' log entry distinct from the tool result"
  );
  console.log(`✓ subscribed client received ${logMessages.length} structured notifications/message log entr(y/ies)`);

  // --- Structured tool output ---
  const listed = await client.callTool({ name: "list_upcoming_tasks", arguments: {} });
  assert.ok(Array.isArray((listed.structuredContent as any)?.tasks));
  console.log("✓ list_upcoming_tasks returns structuredContent alongside the text summary");

  // --- Bulk task import ---
  const preImportNotifications = resourceUpdates.length;
  const importResult = await client.callTool({
    name: "import_tasks",
    arguments: {
      items: [
        { title: "Mow the lawn", dueDate: "2026-09-05" },
        { title: "Clean the gutters", dueDate: "2026-09-06", assignee: "Sam" },
        { dueDate: "2026-09-07" }, // missing title — rejected
        { title: "Bad date task", dueDate: "not-a-date" }, // malformed date — rejected
        { title: "Vacuum the hallway", dueDate: "2026-09-08" },
      ],
    },
  });
  const importData = importResult.structuredContent as any;
  assert.equal(importData.addedCount, 3);
  assert.equal(importData.rejectedCount, 2);
  assert.equal(importData.results.length, 5);
  const rejected = importData.results.filter((r: any) => r.status === "rejected");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r: any) => typeof r.reason === "string" && r.reason.length > 0));
  const addedTitles = importData.results.filter((r: any) => r.status === "added").map((r: any) => r.title).sort();
  assert.deepEqual(addedTitles, ["Clean the gutters", "Mow the lawn", "Vacuum the hallway"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    resourceUpdates.length - preImportNotifications,
    1,
    "expected exactly one combined resource-update notification for the whole batch, not one per item"
  );
  console.log("✓ import_tasks adds valid items, reports per-item rejection reasons, and fires a single notification");

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
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    logMessages.some((m) => (m.data as any)?.message === "Reorder confirmed"),
    "expected a 'Reorder confirmed' log entry"
  );
  console.log("✓ reorder_item confirms via MCP elicitation, then executes, logging a 'Reorder confirmed' entry");

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
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    logMessages.some((m) => (m.data as any)?.message === "Budget exceeded"),
    "expected a 'Budget exceeded' log entry"
  );
  console.log("✓ add_expense flags an over-budget category and logs a 'Budget exceeded' entry");

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

  // --- Recurring/template tasks ---
  // Anchor the recurrence on *today's* weekday so a 14-day window is
  // guaranteed to contain occurrences in both this week and next week —
  // exercising materialization "across multiple weeks" regardless of which
  // day this test happens to run on.
  const recurringWeekday = new Date().getDay();
  const recurring = await client.callTool({
    name: "add_recurring_task",
    arguments: { title: "Take out the compost", daysOfWeek: [recurringWeekday] },
  });
  assert.match((recurring.content as any)[0].text, /Added recurring task "Take out the compost"/);

  const twoWeekWindow = await client.callTool({ name: "list_upcoming_tasks", arguments: { withinDays: 14 } });
  const compostOccurrences = ((twoWeekWindow.structuredContent as any).tasks as any[])
    .filter((t: any) => t.title === "Take out the compost")
    .sort((a: any, b: any) => a.dueDate.localeCompare(b.dueDate));
  // Today + 7 days + 14 days, all landing on recurringWeekday, all <= the 14-day cutoff.
  assert.equal(compostOccurrences.length, 3, `expected 3 occurrences over 14 days, got ${compostOccurrences.length}`);
  const occurrenceIds = new Set(compostOccurrences.map((t: any) => t.id));
  assert.equal(occurrenceIds.size, 3, "expected a distinct synthetic ID per occurrence, not one shared row");
  for (let i = 1; i < compostOccurrences.length; i++) {
    const gapDays =
      (new Date(compostOccurrences[i].dueDate).getTime() - new Date(compostOccurrences[i - 1].dueDate).getTime()) /
      (24 * 60 * 60 * 1000);
    assert.equal(gapDays, 7, "consecutive occurrences should be exactly one week apart");
  }
  assert.ok(compostOccurrences.every((t: any) => t.done === false));
  console.log("✓ add_recurring_task materializes weekly occurrences across multiple weeks in list_upcoming_tasks");

  // --- Household digest export ---
  const digest = await client.callTool({ name: "export_household_digest", arguments: { withinDays: 7 } });
  const digestText = (digest.content as any)[0].text as string;
  assert.match(digestText, /HOUSEHOLD DIGEST/);
  assert.match(digestText, /TASKS DUE/);
  assert.match(digestText, /BUDGET STATUS/);
  assert.match(digestText, /LOW STOCK/);
  const digestData = digest.structuredContent as any;
  assert.equal(digestData.narrative, "Mock digest: everything looks under control this week.");
  assert.ok(Array.isArray(digestData.tasks) && digestData.tasks.length > 0);
  assert.ok(
    digestData.budgets.some((b: any) => b.category === "pets" && b.overBudget === true),
    "expected the digest's budget section to reflect the actual over-budget pets category"
  );
  const lowStockCheck = await client.callTool({ name: "list_low_stock_items", arguments: {} });
  const lowStockNames = ((lowStockCheck.structuredContent as any).items as any[]).map((i: any) => i.name).sort();
  assert.deepEqual(
    digestData.lowStockItems.map((i: any) => i.name).sort(),
    lowStockNames,
    "expected the digest's low-stock section to match list_low_stock_items exactly"
  );
  console.log("✓ export_household_digest combines accurate task, budget, and low-stock data into one report");

  // --- Role-based access control ---
  const roTokenResult = await client.callTool({ name: "issue_household_token", arguments: { role: "read-only" } });
  const roTokenData = roTokenResult.structuredContent as any;
  assert.equal(roTokenData.role, "read-only");
  const readOnlyToken = roTokenData.token as string;

  const { client: readOnlyClient } = await connectClient(baseUrl, readOnlyToken);
  const roList = await readOnlyClient.callTool({ name: "list_upcoming_tasks", arguments: { withinDays: 30 } });
  const roTitles = ((roList.structuredContent as any).tasks as any[]).map((t: any) => t.title);
  assert.ok(roTitles.includes("Water the plants"), "read-only token should see the same household's existing data");
  console.log("✓ a read-only token can call read tools and sees the issuing household's real data");

  const roWriteAttempt = await readOnlyClient.callTool({
    name: "add_task",
    arguments: { title: "Should never be added", dueDate: "2026-09-20" },
  });
  assert.equal(roWriteAttempt.isError, true);
  assert.match((roWriteAttempt.content as any)[0].text, /read-only/i);
  const afterRoAttempt = await client.callTool({ name: "list_upcoming_tasks", arguments: { withinDays: 30 } });
  const afterRoTitles = ((afterRoAttempt.structuredContent as any).tasks as any[]).map((t: any) => t.title);
  assert.ok(!afterRoTitles.includes("Should never be added"), "the rejected write must not have actually happened");
  await readOnlyClient.close();
  console.log('✓ a read-only token is rejected with a clear error on add_task, and the write did not silently succeed');

  // --- Outbound household-alert webhooks ---
  const webhookListener = await startWebhookListener();
  const webhookReg = await client.callTool({ name: "register_alert_webhook", arguments: { url: webhookListener.url } });
  const webhookRegData = webhookReg.structuredContent as any;
  assert.ok(typeof webhookRegData.secret === "string" && webhookRegData.secret.length > 0);

  // A fresh category (not the already-over-budget "pets" from earlier) so this
  // alert is unambiguously the one triggered by *this* over-budget expense.
  await client.callTool({ name: "set_budget", arguments: { category: "groceries", amount: 10 } });
  await client.callTool({ name: "add_expense", arguments: { description: "Grocery run", amount: 25, category: "groceries" } });
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the fire-and-forget delivery land

  const budgetDeliveries = webhookListener
    .received()
    .map((d) => ({ ...d, parsed: JSON.parse(d.body) }))
    .filter((d) => d.parsed.type === "budget_exceeded");
  assert.ok(budgetDeliveries.length > 0, "expected at least one budget_exceeded webhook delivery");
  const budgetDelivery = budgetDeliveries[budgetDeliveries.length - 1];
  const expectedSignature = createHmac("sha256", webhookRegData.secret).update(budgetDelivery.body).digest("hex");
  assert.equal(budgetDelivery.headers["x-homeops-signature"], expectedSignature);
  assert.equal(budgetDelivery.headers["x-homeops-alert-type"], "budget_exceeded");
  assert.equal(budgetDelivery.parsed.data.category, "groceries");
  assert.equal(typeof budgetDelivery.parsed.householdId, "string");
  console.log("✓ register_alert_webhook delivers a correctly HMAC-SHA256-signed budget_exceeded alert to a local listener");

  await client.callTool({ name: "add_task", arguments: { title: "Way overdue chore", dueDate: "2020-01-01" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const overdueDelivery = webhookListener.received().find((d) => JSON.parse(d.body).type === "task_overdue");
  assert.ok(overdueDelivery, "expected a task_overdue webhook delivery");
  const overduePayload = JSON.parse(overdueDelivery!.body);
  assert.ok(overduePayload.data.tasks.some((t: any) => t.title === "Way overdue chore"));
  console.log("✓ adding an already-overdue task also fires a signed task_overdue webhook alert");

  const webhookStatus = await client.callTool({ name: "get_alert_webhook_status", arguments: {} });
  assert.match((webhookStatus.content as any)[0].text, /Last success/);
  webhookListener.close();
  console.log("✓ get_alert_webhook_status reports the most recent successful delivery");

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

  // --- Bearer-token multi-household isolation ---
  const tokenA = `alice-${randomUUID()}`;
  const tokenB = `bob-${randomUUID()}`;
  const { client: clientA } = await connectClient(baseUrl, tokenA);
  const { client: clientB } = await connectClient(baseUrl, tokenB);

  await clientA.callTool({ name: "add_task", arguments: { title: "Alice-only task", dueDate: "2026-09-04" } });
  await clientB.callTool({ name: "add_task", arguments: { title: "Bob-only task", dueDate: "2026-09-04" } });

  const tasksSeenByA = await clientA.callTool({ name: "list_upcoming_tasks", arguments: { withinDays: 30 } });
  const tasksSeenByB = await clientB.callTool({ name: "list_upcoming_tasks", arguments: { withinDays: 30 } });
  const titlesA = ((tasksSeenByA.structuredContent as any).tasks as any[]).map((t) => t.title);
  const titlesB = ((tasksSeenByB.structuredContent as any).tasks as any[]).map((t) => t.title);

  assert.ok(titlesA.includes("Alice-only task"));
  assert.ok(!titlesA.includes("Bob-only task"));
  assert.ok(titlesB.includes("Bob-only task"));
  assert.ok(!titlesB.includes("Alice-only task"));
  // Fresh token-derived households start empty (no seeded demo data), unlike
  // the no-token default household exercised above.
  assert.equal(titlesA.length, 1);
  assert.equal(titlesB.length, 1);
  console.log("✓ two different bearer tokens see completely isolated household data");

  await clientA.close();
  await clientB.close();
  httpServer.close();

  // --- Durable persistence across a simulated restart ---
  // Two independent server instances (fresh Express app, fresh EventStore,
  // fresh Map of transports — nothing shared in memory) pointed at the same
  // on-disk HOMEOPS_DATA_DIR under the same bearer token, standing in for a
  // real process restart against the same data directory.
  const restartToken = `restart-${randomUUID()}`;

  const serverInstance1 = startServer();
  const { client: restartClient1 } = await connectClient(serverInstance1.baseUrl, restartToken);
  await restartClient1.callTool({
    name: "add_task",
    arguments: { title: "Persisted across restart", dueDate: "2026-09-10" },
  });
  await restartClient1.close();
  serverInstance1.httpServer.close();

  const serverInstance2 = startServer();
  const { client: restartClient2 } = await connectClient(serverInstance2.baseUrl, restartToken);
  const tasksAfterRestart = await restartClient2.callTool({
    name: "list_upcoming_tasks",
    arguments: { withinDays: 30 },
  });
  const titlesAfterRestart = ((tasksAfterRestart.structuredContent as any).tasks as any[]).map((t) => t.title);
  assert.ok(titlesAfterRestart.includes("Persisted across restart"));
  await restartClient2.close();
  serverInstance2.httpServer.close();
  console.log("✓ household data survives a simulated restart (fresh server instance, same on-disk data dir)");

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
