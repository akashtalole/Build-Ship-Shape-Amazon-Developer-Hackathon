/**
 * End-to-end smoke test: spins up the HomeOps MCP server on an ephemeral
 * port, connects a real MCP client over Streamable HTTP, and exercises
 * every capability — tools, resources (+ subscribe/notify), prompts,
 * elicitation, sampling, bearer-token multi-tenancy, structured logging,
 * file-backed persistence across a simulated restart, bulk task import,
 * role-based access control, outbound alert webhooks (HMAC-signed, against
 * a real local HTTP listener), recurring tasks, the household digest
 * export, a smart meal planner cross-referencing shopping/budget/tasks, a
 * chore-to-allowance ledger, a sampling-backed freeform capture/dispatcher
 * tool, proactive anomaly-flag detection, Claude on Amazon Bedrock as the
 * model behind those tools when a client can't sample (against a fake HTTP
 * endpoint, through the real Bedrock SDK), and the trimmed voice tool
 * profile. Run with `npm test`.
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
import {
  AnthropicTextModel,
  BEDROCK_FALLBACK_MODEL,
  BedrockTextModel,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_BEDROCK_MODEL,
  configureTextModelFromEnv,
  setTextModel,
} from "../src/llm.js";
import { VOICE_PROFILE_TOOLS, type ToolProfile } from "../src/toolProfile.js";

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
function startServer(profile: ToolProfile = "full"): { httpServer: HttpServer; baseUrl: URL } {
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
    await createHomeOpsServer(householdId, role, profile).connect(transport);
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

// Fixed "5 days from now" used by both the mocked sampling response for the
// capture_note task-classification scenario below and the test's own
// assertion against it — computed once, at module load, from the real
// clock, so the test isn't sensitive to which day it happens to run on.
const CAPTURE_TASK_DUE_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toISOString().slice(0, 10);
})();

/** ISO date N days from whenever the test actually runs, so fixture dates never depend on which day that is. */
function daysFromNowStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Connects an MCP client (with elicitation/sampling stubs wired in),
 * optionally under a bearer token. Pass `{ sampling: false }` to omit both
 * the capability declaration and the CreateMessage handler entirely — the
 * SDK responds "Method not found" to any sampling request the server makes,
 * exercising the same fallback path a client with no sampling support at all
 * would trigger (see capture_note's and generate_weekly_narrative's
 * try/catch around server.server.createMessage).
 */
async function connectClient(baseUrl: URL, token?: string, opts: { sampling?: boolean } = {}) {
  const supportsSampling = opts.sampling !== false;
  const client = new Client(
    { name: "homeops-smoke-test", version: "0.1.0" },
    { capabilities: { elicitation: { form: {} }, ...(supportsSampling ? { sampling: {} } : {}) } }
  );

  // Auto-accept any confirmation the server elicits.
  client.setRequestHandler(ElicitRequestSchema, async () => {
    return { action: "accept", content: { confirmReorder: true } };
  });

  if (supportsSampling) {
    // Mock the client-side "LLM" the server samples from. capture_note's
    // classification prompt is distinguished from generate_weekly_narrative
    // et al.'s digest-narration prompt by its distinctive instruction text,
    // and within that, by keywords from the specific note under test — a
    // small scripted "model" standing in for a real one, same idea as the
    // digest mock every other sampling-backed tool already relies on.
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const promptText =
        request.params.messages[0]?.content.type === "text" ? request.params.messages[0].content.text : "";

      if (promptText.includes("Classify this one household note")) {
        if (promptText.includes("almost out of chicken")) {
          return { role: "assistant", content: { type: "text", text: '{"type":"shopping","item":"chicken breasts"}' }, model: "mock-model" };
        }
        if (promptText.includes("more rice")) {
          return { role: "assistant", content: { type: "text", text: '{"type":"shopping","item":"rice"}' }, model: "mock-model" };
        }
        if (promptText.includes("pick up dry cleaning")) {
          return {
            role: "assistant",
            content: {
              type: "text",
              // Wrapped in a code fence on purpose — exercises capture_note's
              // fence-stripping JSON extraction, not just a bare JSON string.
              text: `\`\`\`json\n{"type":"task","title":"Pick up dry cleaning","dueDate":"${CAPTURE_TASK_DUE_DATE}"}\n\`\`\``,
            },
            model: "mock-model",
          };
        }
        if (promptText.includes("Spent 45 dollars")) {
          return {
            role: "assistant",
            content: {
              type: "text",
              text: '{"type":"expense","description":"Hardware store supplies","amount":45,"category":"maintenance"}',
            },
            model: "mock-model",
          };
        }
        // Deliberately not valid classification JSON — exercises
        // capture_note's fallback-to-task path even though sampling itself
        // "worked" (the client answered), because the answer can't be parsed.
        return { role: "assistant", content: { type: "text", text: "Sorry, I can't classify that." }, model: "mock-model" };
      }

      return {
        role: "assistant",
        content: { type: "text", text: "Mock digest: everything looks under control this week." },
        model: "mock-model",
      };
    });
  }

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

type FakeBedrockMode = "normal" | "refuse-primary" | "error";

/**
 * Stands in for the Bedrock Mantle HTTP endpoint so the real
 * AnthropicBedrockMantle client (request building, refusal-fallback
 * middleware, retries) runs end to end without AWS credentials.
 */
function fakeBedrock() {
  const requests: { url: string; body: any; headers: Headers }[] = [];
  let mode: FakeBedrockMode = "normal";

  const message = (model: string, text: string | null, extra: Record<string, unknown> = {}) => ({
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: text === null ? [] : [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, body, headers: new Headers(init?.headers) });

    if (mode === "error") {
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    let payload: unknown;
    if (mode === "refuse-primary" && body.model === DEFAULT_BEDROCK_MODEL) {
      payload = message(body.model, null, {
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: null,
          explanation: null,
          fallback_credit_token: "credit-token-1",
          fallback_has_prefill_claim: false,
        },
      });
    } else {
      const prompt = String(body.messages?.[0]?.content ?? "");
      const text = prompt.includes("Classify this one household note")
        ? '{"type":"shopping","item":"dish soap"}'
        : body.model === BEDROCK_FALLBACK_MODEL
          ? "Fallback digest: a quiet day at home."
          : "Bedrock digest: nothing due and the pantry is fine.";
      payload = message(body.model, text);
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    setMode(next: FakeBedrockMode) {
      mode = next;
    },
  };
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
    "capture_note",
    "export_household_digest",
    "generate_weekly_narrative",
    "get_alert_webhook_status",
    "get_allowance_balance",
    "get_budget_status",
    "get_proactive_alerts",
    "get_weekly_summary",
    "import_tasks",
    "issue_household_token",
    "list_low_stock_items",
    "list_upcoming_tasks",
    "mark_task_done",
    "record_allowance_payout",
    "register_alert_webhook",
    "reorder_item",
    "run_morning_briefing",
    "set_budget",
    "set_task_reward",
    "suggest_assignee",
    "suggest_meal_plan",
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
  assert.match(digestText, /WORTH ATTENTION/);
  const digestData = digest.structuredContent as any;
  assert.equal(digestData.narrative, "Mock digest: everything looks under control this week.");
  assert.ok(Array.isArray(digestData.tasks) && digestData.tasks.length > 0);
  assert.ok(Array.isArray(digestData.anomalies));
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

  // --- Chore-to-allowance ledger ---
  await client.callTool({
    name: "add_task",
    arguments: { title: "Wash the car", dueDate: daysFromNowStr(20), assignee: "Jordan" },
  });
  const beforeReward = await client.callTool({ name: "list_upcoming_tasks", arguments: { withinDays: 30 } });
  const washCarTask = ((beforeReward.structuredContent as any).tasks as any[]).find(
    (t: any) => t.title === "Wash the car" && !t.done
  );
  assert.ok(washCarTask, "expected to find the newly added 'Wash the car' task");

  const rewardSet = await client.callTool({ name: "set_task_reward", arguments: { taskId: washCarTask.id, amount: 2.5 } });
  assert.match((rewardSet.content as any)[0].text, /worth 2\.50 to Jordan/);

  const completedReward = await client.callTool({ name: "mark_task_done", arguments: { taskId: washCarTask.id } });
  const completedRewardText = (completedReward.content as any)[0].text as string;
  assert.match(completedRewardText, /Marked "Wash the car" as done\./);
  assert.match(completedRewardText, /Jordan earned 2\.50 \(allowance balance: 2\.50\)/);

  const balanceAfterChore = await client.callTool({ name: "get_allowance_balance", arguments: { member: "Jordan" } });
  assert.equal(((balanceAfterChore.structuredContent as any).balances[0] as any).balance, 2.5);

  const payout = await client.callTool({ name: "record_allowance_payout", arguments: { member: "Jordan" } });
  const payoutData = payout.structuredContent as any;
  assert.equal(payoutData.paidOut, 2.5);
  assert.equal(payoutData.remainingBalance, 0);

  const balanceAfterPayout = await client.callTool({ name: "get_allowance_balance", arguments: { member: "Jordan" } });
  assert.equal(((balanceAfterPayout.structuredContent as any).balances[0] as any).balance, 0);
  console.log("✓ set_task_reward + mark_task_done credits an allowance balance, and record_allowance_payout settles it");

  // --- Freeform capture / dispatcher tool (capture_note) ---
  const captureShopping1 = await client.callTool({
    name: "capture_note",
    arguments: { text: "We're almost out of chicken breasts" },
  });
  const captureShopping1Data = captureShopping1.structuredContent as any;
  assert.equal(captureShopping1Data.routedTo, "shopping");
  assert.equal(captureShopping1Data.usedSampling, true);
  assert.match(captureShopping1Data.itemName.toLowerCase(), /chicken/);

  await client.callTool({ name: "capture_note", arguments: { text: "We need more rice" } });

  const lowStockAfterCapture = await client.callTool({ name: "list_low_stock_items", arguments: {} });
  const lowStockNamesAfterCapture = ((lowStockAfterCapture.structuredContent as any).items as any[]).map((i: any) =>
    i.name.toLowerCase()
  );
  assert.ok(lowStockNamesAfterCapture.some((n: string) => n.includes("chicken")));
  assert.ok(lowStockNamesAfterCapture.includes("rice"));
  console.log("✓ capture_note routes a freeform 'running low' sentence onto the shopping/low-stock list via MCP sampling");

  const captureTask = await client.callTool({
    name: "capture_note",
    arguments: { text: "I need to pick up dry cleaning by Friday" },
  });
  const captureTaskData = captureTask.structuredContent as any;
  assert.equal(captureTaskData.routedTo, "task");
  assert.equal(captureTaskData.usedSampling, true);
  assert.equal(captureTaskData.title, "Pick up dry cleaning");
  assert.equal(captureTaskData.dueDate, CAPTURE_TASK_DUE_DATE);
  console.log("✓ capture_note routes a freeform task sentence (with a due date) via MCP sampling");

  const captureExpense = await client.callTool({
    name: "capture_note",
    arguments: { text: "Spent 45 dollars on hardware store supplies" },
  });
  const captureExpenseData = captureExpense.structuredContent as any;
  assert.equal(captureExpenseData.routedTo, "expense");
  assert.equal(captureExpenseData.usedSampling, true);
  assert.equal(captureExpenseData.amount, 45);
  assert.equal(captureExpenseData.category, "maintenance");
  console.log("✓ capture_note routes a freeform expense sentence via MCP sampling");

  const captureGibberish = await client.callTool({
    name: "capture_note",
    arguments: { text: "asdkjhasdkjh not classifiable gibberish" },
  });
  const captureGibberishData = captureGibberish.structuredContent as any;
  assert.equal(captureGibberishData.routedTo, "task");
  assert.equal(captureGibberishData.usedSampling, false);
  assert.equal(captureGibberishData.title, "asdkjhasdkjh not classifiable gibberish");
  console.log("✓ capture_note falls back to a task when the model's reply can't be parsed as classification JSON");

  const { client: noSamplingClient } = await connectClient(baseUrl, `no-sampling-${randomUUID()}`, { sampling: false });
  const captureNoSampling = await noSamplingClient.callTool({
    name: "capture_note",
    arguments: { text: "Take out recycling tomorrow" },
  });
  const captureNoSamplingData = captureNoSampling.structuredContent as any;
  assert.equal(captureNoSamplingData.routedTo, "task");
  assert.equal(captureNoSamplingData.usedSampling, false);
  assert.equal(captureNoSamplingData.title, "Take out recycling tomorrow");
  await noSamplingClient.close();
  console.log("✓ capture_note falls back to a task outright when the connected client doesn't support MCP sampling at all");

  // --- Smart meal planner ---
  await client.callTool({ name: "set_budget", arguments: { category: "groceries", amount: 100 } });
  const mealPlan = await client.callTool({ name: "suggest_meal_plan", arguments: { days: 3 } });
  const mealPlanData = mealPlan.structuredContent as any;
  assert.equal(mealPlanData.days.length, 3);
  // Groceries budget was set to 100 above; the only groceries expense logged
  // anywhere in this run was the $25 "Grocery run" from the webhook test
  // earlier, so remaining should be exactly 75 — not a coincidence, a check
  // that suggest_meal_plan reads the *real* remaining budget, not a guess.
  assert.equal(mealPlanData.groceryBudgetRemaining, 75);
  assert.ok(mealPlanData.totalEstCost <= mealPlanData.groceryBudgetRemaining);
  assert.equal(mealPlanData.withinBudget, true);
  assert.ok((mealPlanData.lowStockConsidered as string[]).some((n) => n.includes("chicken")));
  assert.ok((mealPlanData.lowStockConsidered as string[]).includes("rice"));
  assert.ok(
    (mealPlanData.days as any[]).some((d: any) => d.usesLowStockItems.length > 0),
    "expected at least one planned day to actually use a low-stock ingredient"
  );
  for (const d of mealPlanData.days as any[]) {
    if (d.busyDay) assert.equal(d.quickMeal, true, `expected busy day ${d.date} to get a quick meal`);
  }
  console.log("✓ suggest_meal_plan cross-references low-stock items, remaining grocery budget, and busy days into a real plan");

  // --- Proactive household digest with anomaly flags ---
  // Force a task-load imbalance: pile several explicit-assignee tasks onto
  // one member well past whatever fair rotation had already produced.
  for (let i = 0; i < 4; i++) {
    await client.callTool({
      name: "add_task",
      arguments: { title: `Extra chore ${i}`, dueDate: daysFromNowStr(25), assignee: "Sam" },
    });
  }
  // A fresh category, spent well past a sustainable pace on day one of its
  // rolling week, but not yet actually over budget.
  await client.callTool({ name: "set_budget", arguments: { category: "entertainment", amount: 20 } });
  await client.callTool({ name: "add_expense", arguments: { description: "Movie night", amount: 10, category: "entertainment" } });

  const alerts = await client.callTool({ name: "get_proactive_alerts", arguments: {} });
  const alertsData = alerts.structuredContent as any;
  const alertTypes = (alertsData.anomalies as any[]).map((a: any) => a.type);
  assert.ok(alertTypes.includes("task_pileup"));
  assert.ok(alertTypes.includes("spending_trend"));
  assert.ok(alertTypes.includes("stale_low_stock"));
  assert.equal(alertsData.count, alertsData.anomalies.length);

  const pileup = (alertsData.anomalies as any[]).find((a: any) => a.type === "task_pileup");
  assert.equal(pileup.data.mostLoaded, "Sam");

  // Both "groceries" (bumped to a $100 budget just above, with the same-day
  // $25 spend from the earlier webhook test) and "entertainment" now trend
  // over pace — assert on entertainment specifically rather than "the"
  // spending_trend entry, since there may legitimately be more than one.
  const trend = (alertsData.anomalies as any[]).find((a: any) => a.type === "spending_trend" && a.data.category === "entertainment");
  assert.ok(trend, "expected an entertainment spending_trend anomaly");
  assert.ok(trend.data.paceRatio >= 1.3, "expected the entertainment category to be flagged as trending over its weekly pace");

  const stale = (alertsData.anomalies as any[]).filter((a: any) => a.type === "stale_low_stock");
  assert.ok(
    stale.some((a: any) => a.data.itemName.toLowerCase().includes("chicken")),
    "expected the never-reordered captured chicken item to be flagged as stale low stock"
  );
  console.log("✓ get_proactive_alerts flags a task pileup, a spending-pace trend, and stale low-stock items nobody asked about");

  const digestAfterAnomalies = await client.callTool({ name: "export_household_digest", arguments: { withinDays: 7 } });
  const digestAfterAnomaliesData = digestAfterAnomalies.structuredContent as any;
  assert.ok(
    (digestAfterAnomaliesData.anomalies as any[]).length >= alertsData.count,
    "expected export_household_digest to surface at least the same anomalies as get_proactive_alerts"
  );
  assert.doesNotMatch((digestAfterAnomalies.content as any)[0].text as string, /WORTH ATTENTION\n {2}Nothing flagged\./);
  console.log("✓ export_household_digest's WORTH ATTENTION section reuses the same anomaly detection, not a duplicate copy");

  await client.close();

  // --- Claude on Amazon Bedrock behind the sampling-dependent tools ---
  const bedrock = fakeBedrock();
  setTextModel(new BedrockTextModel({ awsRegion: "us-east-1", skipAuth: true, fetch: bedrock.fetch }));

  const { client: bedrockClient } = await connectClient(baseUrl, `bedrock-${randomUUID()}`, { sampling: false });
  const bedrockNarrative = await bedrockClient.callTool({ name: "generate_weekly_narrative", arguments: {} });
  assert.equal((bedrockNarrative.content as any)[0].text, "Bedrock digest: nothing due and the pantry is fine.");
  assert.equal(bedrock.requests.length, 1);
  const narrativeRequest = bedrock.requests[0];
  assert.match(narrativeRequest.url, /^https:\/\/bedrock-mantle\.us-east-1\.api\.aws\/anthropic\/v1\/messages/);
  assert.equal(narrativeRequest.body.model, DEFAULT_BEDROCK_MODEL);
  assert.equal(narrativeRequest.body.output_config.effort, "low");
  assert.match(String(narrativeRequest.body.messages[0].content), /"lowStock"/);
  console.log("✓ generate_weekly_narrative uses Claude on Bedrock (real SDK request to the Mantle endpoint) when the client can't sample");

  const bedrockCapture = await bedrockClient.callTool({ name: "capture_note", arguments: { text: "We're out of dish soap" } });
  const bedrockCaptureData = bedrockCapture.structuredContent as any;
  assert.equal(bedrockCaptureData.routedTo, "shopping");
  assert.equal(bedrockCaptureData.classifiedBy, "bedrock");
  assert.equal(bedrockCaptureData.usedSampling, false);
  assert.equal(bedrockCaptureData.itemName, "dish soap");
  console.log("✓ capture_note classifies via Claude on Bedrock when the client can't sample");

  const requestsBeforeSampling = bedrock.requests.length;
  const { client: samplingClient } = await connectClient(baseUrl, `sampling-${randomUUID()}`);
  const sampledNarrative = await samplingClient.callTool({ name: "generate_weekly_narrative", arguments: {} });
  assert.equal((sampledNarrative.content as any)[0].text, "Mock digest: everything looks under control this week.");
  assert.equal(bedrock.requests.length, requestsBeforeSampling);
  await samplingClient.close();
  console.log("✓ MCP sampling is still preferred over Bedrock when the client supports it (no Bedrock call made)");

  bedrock.setMode("refuse-primary");
  const requestsBeforeRefusal = bedrock.requests.length;
  const fallbackBriefing = await bedrockClient.callTool({ name: "run_morning_briefing", arguments: {} });
  assert.match((fallbackBriefing.content as any)[0].text, /^Fallback digest/);
  const refusalHops = bedrock.requests.slice(requestsBeforeRefusal);
  assert.equal(refusalHops.length, 2);
  assert.equal(refusalHops[0].body.model, DEFAULT_BEDROCK_MODEL);
  assert.equal(refusalHops[1].body.model, BEDROCK_FALLBACK_MODEL);
  assert.equal(refusalHops[1].body.fallback_credit_token?.token, "credit-token-1");
  console.log(`✓ a refusal from ${DEFAULT_BEDROCK_MODEL} is retried on ${BEDROCK_FALLBACK_MODEL} with the fallback credit token`);

  bedrock.setMode("error");
  const degradedBriefing = await bedrockClient.callTool({ name: "run_morning_briefing", arguments: {} });
  assert.notEqual(degradedBriefing.isError, true);
  assert.match((degradedBriefing.content as any)[0].text, /\(Templated digest — no language model available\.\)$/);
  console.log("✓ a failing Bedrock endpoint degrades to the templated briefing instead of erroring the tool call");

  await bedrockClient.close();
  setTextModel(null);

  // --- Claude via the Anthropic API (API-key deployments) ---
  const anthropicApi = fakeBedrock();
  setTextModel(
    new AnthropicTextModel({ apiKey: "sk-ant-test-key", baseURL: "https://anthropic.test", fetch: anthropicApi.fetch })
  );
  const { client: apiClient } = await connectClient(baseUrl, `anthropic-${randomUUID()}`, { sampling: false });
  const apiCapture = await apiClient.callTool({ name: "capture_note", arguments: { text: "We're out of dish soap" } });
  const apiCaptureData = apiCapture.structuredContent as any;
  assert.equal(apiCaptureData.routedTo, "shopping");
  assert.equal(apiCaptureData.classifiedBy, "anthropic");
  const apiRequest = anthropicApi.requests[0];
  assert.match(apiRequest.url, /^https:\/\/anthropic\.test\/v1\/messages/);
  assert.equal(apiRequest.headers.get("x-api-key"), "sk-ant-test-key");
  assert.match(apiRequest.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.equal(apiRequest.body.model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(apiRequest.body.fallbacks, "default");
  assert.equal(apiRequest.body.output_config.effort, "low");
  await apiClient.close();
  setTextModel(null);
  console.log("✓ capture_note classifies via Claude on the Anthropic API (API key, server-side refusal fallback) when configured");

  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(configureTextModelFromEnv({ HOMEOPS_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" })?.source, "anthropic");
    assert.equal(configureTextModelFromEnv({ HOMEOPS_LLM_PROVIDER: "anthropic" }), null);
    assert.equal(configureTextModelFromEnv({ HOMEOPS_LLM_PROVIDER: "bedrock", AWS_REGION: "us-east-1" })?.source, "bedrock");
    assert.equal(configureTextModelFromEnv({ HOMEOPS_USE_BEDROCK: "true", AWS_REGION: "us-east-1" })?.source, "bedrock");
    assert.equal(configureTextModelFromEnv({ HOMEOPS_LLM_PROVIDER: "bedrock" }), null);
    assert.equal(configureTextModelFromEnv({}), null);
  } finally {
    console.warn = quiet;
    setTextModel(null);
  }
  console.log("✓ HOMEOPS_LLM_PROVIDER selects the Anthropic API or Bedrock, and a missing API key or region disables the fallback instead of crashing");

  // --- Voice tool profile ---
  const voiceServer = startServer("voice");
  const { client: voiceClient } = await connectClient(voiceServer.baseUrl, `voice-${randomUUID()}`);
  const voiceTools = (await voiceClient.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(voiceTools, [...VOICE_PROFILE_TOOLS].sort());
  let adminToolRejected = false;
  try {
    const result = await voiceClient.callTool({ name: "issue_household_token", arguments: { role: "read-only" } });
    adminToolRejected = result.isError === true;
  } catch {
    adminToolRejected = true;
  }
  assert.ok(adminToolRejected, "expected a tool outside the voice profile to be uncallable");
  await voiceClient.close();
  voiceServer.httpServer.close();
  console.log(`✓ the voice profile exposes only ${voiceTools.length} household tools and hides admin/setup tools`);

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
