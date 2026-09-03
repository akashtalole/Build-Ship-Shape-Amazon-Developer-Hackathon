# HomeOps — Household Operations MCP Server for Alexa+

Implementation of the "HomeOps" idea from [`hackathon-ideas/alexa-plus.md`](../hackathon-ideas/alexa-plus.md): a
self-hosted [MCP](https://modelcontextprotocol.io) server that lets Alexa+ answer questions like *"what's due this
week"* or *"reorder anything running low"* by orchestrating across household tools — tasks, a shopping/reorder list,
and expense tracking — instead of handling a single isolated command.

Built for the **Alexa+ track** of the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/),
which requires an Agent Skill or a self-hosted MCP server on the 2025-11-25+ spec using Streamable HTTP transport.

## What it does

Alexa+'s agent can call these tools, in combination, to complete multi-step requests:

| Tool | Purpose |
|---|---|
| `list_upcoming_tasks` | Household to-dos due within N days |
| `add_task` | Add a task; auto-assigns fairly if no assignee is given |
| `import_tasks` | Bulk-add many tasks in one call, with a per-item added/rejected result |
| `mark_task_done` | Mark a task complete |
| `suggest_assignee` | Recommend who should take the next chore, by current open-task load |
| `list_low_stock_items` | Items running low that might need reordering |
| `reorder_item` | Reorder an item — confirms via **MCP elicitation** before spending |
| `add_expense` | Log a household expense; warns if it pushes a category over budget |
| `get_weekly_summary` | Total spend by category over the past 7 days |
| `set_budget` / `get_budget_status` | Set and check weekly budgets per category |
| `generate_weekly_narrative` | Turn the week's data into a natural-language digest via **MCP sampling** |
| `sync_household_calendar` | Sync tasks to a shared calendar, streaming **progress notifications** per task |
| `run_morning_briefing` | **Compound tool**: chains tasks + assignment + stock + budget into one call, then narrates them |

Beyond tools, the server also exposes:

- **Resources** (`homeops://tasks/upcoming`, `homeops://shopping/low-stock`, `homeops://budget/status`) that a
  client can subscribe to and get pushed `notifications/resources/updated` events for, instead of polling.
- **A resource template** (`homeops://tasks/{taskId}`) with argument completion, so a client can look up one task
  by ID and get autocomplete suggestions for valid IDs as the user types.
- **A prompt** (`weekly_household_briefing`) — a ready-made template a client can pull instead of hand-assembling
  one from raw tool output.
- **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every tool, so a
  client can decide what needs a confirmation prompt without parsing descriptions.
- **Structured output** (`outputSchema` + `structuredContent`) on the read-heavy tools (`list_upcoming_tasks`,
  `list_low_stock_items`, `get_budget_status`), so a client can render its own UI from typed JSON instead of
  reparsing the text summary.

### Advanced/unique features

- **Elicitation-backed confirmation.** `reorder_item` doesn't rely on a hand-rolled `confirm` boolean flag — it
  calls `server.server.elicitInput(...)` to have the *client* prompt the user directly via a real MCP form
  request, the protocol-correct way to gate a spending action. If the connected client hasn't declared the
  elicitation capability, it gracefully falls back to a preview-then-confirm flow instead of failing.
- **Sampling instead of a bundled LLM key.** `generate_weekly_narrative` has no API key or model of its own — it
  sends a `createMessage` sampling request to the *connected client's* model (Alexa+'s own LLM) to narrate the raw
  household data, and falls back to a templated digest if the client doesn't support sampling.
- **Live resources with push updates.** Task, shopping, and budget state are exposed as MCP resources, and
  `add_task`, `reorder_item`, `add_expense`, and `set_budget` all fire `notifications/resources/updated` to any
  subscriber — a client can watch the household passively instead of re-polling tools.
- **Fair chore rotation.** `add_task` auto-assigns to whichever household member currently has the fewest open
  tasks when no assignee is given, and `suggest_assignee` exposes that logic directly so the agent can explain
  *why* before assigning.
- **Proactive budget alerts.** Categories carry a weekly budget; `add_expense` checks against it immediately and
  surfaces an over-budget warning in the same response, with `homeops://budget/status` updated for subscribers.
- **Progress-streaming long operations.** `sync_household_calendar` reports `notifications/progress` per task as
  it "syncs" (simulated latency), so a client can show a live progress bar instead of a spinner with no feedback.
- **Discoverable, typed resources.** A `ResourceTemplate` (`homeops://tasks/{taskId}`) supplies autocomplete
  suggestions for its `taskId` argument via the MCP completion capability, and read-heavy tools return
  `structuredContent` validated against a declared `outputSchema` alongside their text summary.
- **Tool-use safety hints.** Every tool declares `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`
  annotations, the spec's mechanism for a client to decide which calls are safe to auto-approve.
- **Resumable Streamable HTTP sessions.** The transport is backed by a custom `EventStore` (`src/eventStore.ts`).
  If a client's connection drops mid-conversation, it can reconnect with a `Last-Event-ID` header and receive every
  notification it missed — a task-completion or budget-alert push isn't silently lost to a flaky network. Verified
  by hand against the running server: open the SSE stream, subscribe to a resource, trigger a change, kill the
  connection, trigger a second change while "offline," then reconnect with `Last-Event-ID` and watch the missed
  notification replay (see `docs`/commit history for the exact `curl` sequence).
- **Idempotency-key protected spending.** `reorder_item` accepts an optional `idempotencyKey`; retrying the same
  call with the same key (an agent replay after a timeout, a flaky connection) reorders **at most once** instead of
  double-charging the household — the second call returns "already reordered" with no additional effect.
- **A compound orchestration tool.** `run_morning_briefing` chains four internal operations (today's tasks, fair
  chore assignment, low-stock check, budget status) into a single tool call, then narrates the result via sampling
  — one round trip instead of four, which matters for a voice interaction where every tool call adds latency.
- **Bearer-token multi-household support.** A prior round's README/friction log called out the single in-memory
  household as the project's one hackathon-specific shortcut — this round closes that gap. The client's
  `Authorization: Bearer <token>` header (read once, at session-`initialize` time, at the Express/Streamable-HTTP
  layer in `src/index.ts` — MCP tool handlers never see raw HTTP headers) is hashed into a household ID and closed
  over by every tool/resource that session's `McpServer` registers, so two different tokens never see each other's
  tasks, shopping list, expenses, or budgets. No pre-registration: an unrecognized token just gets a fresh, empty
  household the first time it's used. A request with no token at all falls back to the single well-known default
  household (seeded with the original demo data), so existing demos/tests that don't pass a token keep working
  unchanged.
- **Structured logging via the MCP logging capability.** Beyond a tool's own result, the server emits leveled
  `notifications/message` log entries (`server.server.sendLoggingMessage(...)`, gated on declaring
  `capabilities: { logging: {} }` on the `McpServer`) for key household events — a task added, a bulk import
  completed, a reorder declined or confirmed, a budget exceeded — so a client that's just watching the log stream
  (no `logging/setLevel` call required; every level ships until a client asks to filter) can build a live activity
  feed independent of which tool call triggered each event.
- **Durable, file-backed persistence.** Each household is now a JSON file (`data/<householdId>.json` by default,
  overridable via `HOMEOPS_DATA_DIR`) instead of a plain in-memory object, written with a write-temp-file-then-rename
  so a reader never observes a half-written file. Restarting the server no longer wipes out demo data — see
  "Persistence" below for the explicitly-stated tradeoffs of this approach.
- **Bulk task import.** `import_tasks` accepts an array of `{title, dueDate, assignee?}` objects — "add my whole
  week's chores at once" — validates each item independently, adds every valid one in a single household write, and
  fires exactly one combined `homeops://tasks/upcoming` update notification for the whole batch instead of one per
  item. The result reports each item's outcome (`added` with its new task ID, or `rejected` with a reason) so a
  malformed entry in the middle of a batch doesn't silently disappear or block the rest.

## Persistence

Household data lives in `data/<householdId>.json` (gitignored; created on first use). Every store function reads
its household's file fresh and writes the whole file back (via write-to-temp-then-`rename`, which is atomic on the
same filesystem) after any mutation — there's deliberately no long-lived in-memory cache, which is what makes a
second server instance pointed at the same directory immediately see the first one's writes.

**This is explicitly a demo-grade persistence layer, not a database — a stated tradeoff, not an oversight:**

- No locking beyond what a single writer's atomic rename gives you. Two truly concurrent writers touching the exact
  same household at the same instant could still race (last write wins) — fine for a single household operated by
  one Alexa+ session at a time, not fine for a multi-writer production system.
- No transactions, indexes, or query capability beyond "load the whole household JSON blob."
- No migrations: a change to `types.ts`'s shape doesn't rewrite existing files on disk.
- A read on every call means a stat+read (and a stat+write+rename on every mutation) instead of an in-memory
  lookup — irrelevant at demo scale, but not what you'd want under real load.

Swapping this for a real database (SQLite, DynamoDB, etc.) would mean reimplementing the functions in `src/store.ts`
against it — the rest of the codebase (tools, resources) only calls those functions and doesn't know or care how a
household is stored.

The server holds one household per distinct bearer token (or the single seeded default household for a request with
no token), each independently loaded/saved from its own file.

## Project layout

```
src/
  index.ts        Express app + Streamable HTTP transport; extracts the bearer token per session and resolves
                  it to a household ID (src/auth.ts) before creating that session's McpServer
  auth.ts          extractBearerToken() + resolveHouseholdId() — bearer token -> household ID derivation
  server.ts        createHomeOpsServer(householdId) factory — wires resources, prompts, and all tools onto a
                   fresh McpServer scoped to one household, with the logging capability declared
  store.ts         File-backed household data (tasks, shopping, expenses, budgets), one JSON file per household
                   ID under data/ (HOMEOPS_DATA_DIR-overridable), atomic write-then-rename + fair-rotation/
                   budget/idempotency logic + bulk import
  logging.ts       logEvent() helper over the MCP logging capability (notifications/message)
  resources.ts     homeops:// resources + subscribe/unsubscribe + notify() helper for push updates, scoped by
                   household ID
  eventStore.ts    InMemoryEventStore — Streamable HTTP resumability (replay after a dropped connection)
  prompts.ts       weekly_household_briefing prompt template
  types.ts         Shared data model
  tools/
    tasks.ts       list_upcoming_tasks, add_task, import_tasks, mark_task_done, suggest_assignee,
                   sync_household_calendar
    shopping.ts    list_low_stock_items, reorder_item (elicitation-backed, idempotency-key protected)
    expenses.ts    add_expense, get_weekly_summary, set_budget, get_budget_status
    insights.ts    generate_weekly_narrative, run_morning_briefing (MCP sampling + compound orchestration)
data/              JSON-file-backed household storage, one file per household ID (gitignored, created on first use)
test/
  smoke.test.ts    End-to-end test: real MCP client + server, exercising every tool, resource (+ template,
                   completion, subscribe/notify), prompt, elicitation round-trip, sampling call,
                   progress-streaming tool call, idempotent retry, compound tool, a direct EventStore unit
                   test, bearer-token household isolation, structured logging notifications, file-backed
                   persistence across a simulated restart, and bulk task import
```

## Running it

```bash
npm install
npm run build
npm start
# HomeOps MCP server listening on http://localhost:3333/mcp
```

Or for local iteration:

```bash
npm run dev
```

By default household data is written to `data/` under the current working directory; set `HOMEOPS_DATA_DIR` to
point it elsewhere (the test suite uses this to isolate itself into a scratch directory).

### Connecting with a bearer token (multi-household)

Every client gets its own isolated household, keyed off its `Authorization: Bearer <token>` header:

```bash
curl -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer my-households-token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize", ...}'
```

or, with the SDK's `StreamableHTTPClientTransport`:

```ts
new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: "Bearer my-households-token" } },
});
```

A different token always gets its own fresh, empty household on first use — no pre-registration needed. Omitting
the header entirely connects to the single seeded default household (the one with the original demo tasks/shopping
items), so existing demos and tooling that don't send a token are unaffected.

## Testing

```bash
npm test
```

This starts the server on an ephemeral port, connects a real MCP `Client` over `StreamableHTTPClientTransport`
(with elicitation- and sampling-handling stubs wired in), and drives a full scenario: list tools/resources/prompts →
get a fair-rotation suggestion → add a task and confirm its resource-update notification arrives → bulk-import a
mixed batch of valid/invalid tasks in one call → reorder an item through a live elicitation round-trip → log an
expense and see the over-budget warning → generate a sampling-backed narrative — while asserting along the way that
key events (a task added, a reorder confirmed, a budget exceeded) also arrive as independent
`notifications/message` log entries. It then connects two more clients under two different bearer tokens and
confirms their household data is completely isolated, and finally spins up two independent server instances
pointed at the same on-disk data directory to confirm a household's data survives a simulated restart. No external
services required.

You can also point the [MCP Inspector](https://modelcontextprotocol.io/legacy/tools/inspector) at the running
server for interactive exploration:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3333/mcp
```

## Wiring it up to Alexa+

1. Run the server somewhere reachable over HTTPS (a tunnel like `ngrok http 3333` works for local demos).
2. In the Alexa+ Agent Skill / web app simulator, register the MCP server endpoint (`https://<host>/mcp`), passing
   whatever bearer token identifies that user's household (see above) if you want per-user isolation rather than
   the shared default household.
3. Try prompts such as:
   - "What's due around the house this week?"
   - "Add these chores for the week: recycling Monday, laundry Tuesday, vacuuming Wednesday" (bulk `import_tasks`)
   - "Who should take out the trash?" (fair chore rotation)
   - "Is anything running low?" → "Yes, go ahead and reorder the dog food" (Alexa+ surfaces the elicitation form)
   - "Log $60 for dog food under pets" (triggers the over-budget warning if the pets budget is set below that)
   - "Give me the weekly household briefing" (uses the `weekly_household_briefing` prompt + sampling-backed digest)
   - "Sync my tasks to the calendar" (streams progress notifications as each task syncs)

## Verifying resumability by hand

`npm test` unit-tests the `InMemoryEventStore` class directly; to see the full HTTP-level behavior, run the
server (`npm run build && npm start`) and, in another shell:

```bash
SESSION=<mcp-session-id from your initialize response's headers>

# 1. Subscribe to a resource, then open the standalone SSE stream.
curl -N http://localhost:3333/mcp -H "Accept: text/event-stream" -H "mcp-session-id: $SESSION" &

# 2. Trigger a change (note the "id: ...:000000000002"-style line the stream prints), then Ctrl-C the curl above
#    to simulate a dropped connection.
curl -X POST http://localhost:3333/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_task","arguments":{"title":"Test A","dueDate":"2026-09-05"}}}'

# 3. Trigger a second change while "offline" — a client that just reconnects fresh would miss this entirely.
curl -X POST http://localhost:3333/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_task","arguments":{"title":"Test B","dueDate":"2026-09-06"}}}'

# 4. Reconnect with the last event ID you saw in step 1 — the missed notification from step 3 replays immediately.
curl -N http://localhost:3333/mcp -H "Accept: text/event-stream" -H "mcp-session-id: $SESSION" \
  -H "Last-Event-ID: <the id from step 1>"
```

## Judging-criteria alignment

- **Tech Implementation:** Real Streamable HTTP MCP transport (2025-11-25+ spec) with proper session lifecycle
  (`Mcp-Session-Id` header, per-session `McpServer` instances, session cleanup on close), backed by a custom
  resumable `EventStore` — plus resources (including a completable resource template), prompts, elicitation,
  sampling, structured tool output, tool annotations, progress notifications, and the logging capability
  (`notifications/message`): essentially the full breadth of the MCP spec rather than tools alone. Bearer-token
  auth is threaded from the HTTP layer into per-session state the same way a real multi-tenant MCP server would.
- **Design:** Tools are scoped and composable so the agent can chain them (check → decide → act), with
  `run_morning_briefing` collapsing the common four-tool chain into one round trip for latency-sensitive voice
  interactions, and `import_tasks` collapsing a whole batch of adds into one round trip and one notification. The
  one spending tool (`reorder_item`) confirms through the protocol's own elicitation mechanism and is safe to retry
  via an idempotency key, and every capability degrades gracefully when a client doesn't support it.
- **Potential Impact:** A genuinely useful daily-use pattern (household coordination, fair chore-splitting, budget
  awareness) rather than a novelty demo, with production-grade concerns actually handled — safe retries on the
  spending path, connection resumability, per-household data isolation via bearer tokens, and data that survives a
  restart — not just a happy-path demo. The remaining hackathon-specific shortcut is the persistence layer itself
  (a JSON file per household, no real database) — explicitly documented as such, not hidden.
- **Quality of Idea:** Demonstrates multi-tool agentic orchestration *and* deep MCP protocol usage (resources with
  live push updates, sampling instead of a bundled model key, resumable transport, idempotent writes, structured
  logging as a first-class observability channel) — the actual differentiators between an "Agent Skill" and a
  legacy single-intent Alexa Skill.

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
judging bonus).
