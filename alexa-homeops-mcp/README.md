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
| `list_upcoming_tasks` | Household to-dos due within N days (materializes recurring-task occurrences on the fly) |
| `add_task` | Add a task; auto-assigns fairly if no assignee is given |
| `add_recurring_task` | Add a weekly recurring chore template (e.g. "every Tuesday") — no per-week row needed |
| `import_tasks` | Bulk-add many tasks in one call, with a per-item added/rejected result |
| `mark_task_done` | Mark a task complete |
| `suggest_assignee` | Recommend who should take the next chore, by current open-task load |
| `list_low_stock_items` | Items running low that might need reordering |
| `reorder_item` | Reorder an item — confirms via **MCP elicitation** before spending |
| `add_expense` | Log a household expense; warns if it pushes a category over budget, and fires an alert webhook |
| `get_weekly_summary` | Total spend by category over the past 7 days |
| `set_budget` / `get_budget_status` | Set and check weekly budgets per category |
| `generate_weekly_narrative` | Turn the week's data into a natural-language digest via **MCP sampling** |
| `sync_household_calendar` | Sync tasks to a shared calendar, streaming **progress notifications** per task |
| `run_morning_briefing` | **Compound tool**: chains tasks + assignment + stock + budget into one call, then narrates them |
| `export_household_digest` | Combined tasks + budget + low-stock text report, reusing the sampling-backed narrative |
| `issue_household_token` | Mint a new bearer token for this household as `full-access` or `read-only` |
| `register_alert_webhook` | Register an HMAC-signed callback URL for proactive budget/overdue-task alerts |
| `get_alert_webhook_status` | Check whether a webhook is registered and how its last delivery went |
| `suggest_meal_plan` | **Smart meal planner**: cross-references low stock, remaining groceries budget, and busy days into a plan |
| `set_task_reward` | Attach an allowance amount to an existing task, paid to its assignee once it's completed |
| `get_allowance_balance` | Check one (or every) household member's running allowance balance |
| `record_allowance_payout` | Record an allowance payout, reducing (or zeroing) a member's balance |
| `capture_note` | **Freeform dispatcher**: classifies one sentence via MCP sampling and routes it to shopping/task/expense |
| `get_proactive_alerts` | Surface anomalies nobody asked about: task pileup, a budget trending high, stale low-stock items |

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
- **Role-based access control.** Every bearer token now resolves to both a household *and* an access role
  (`full-access` or `read-only`), via `issue_household_token` — a full-access session can mint a new token for its
  *own* household at either level, e.g. a read-only one for a kid's device or a shared kitchen display that should
  only ever check things. A read-only token can call every read tool (`list_upcoming_tasks`, `get_budget_status`,
  `export_household_digest`, ...) but is rejected — with a clear `isError` message, never a silent no-op — on every
  write tool (`add_task`, `reorder_item`, `add_expense`, `import_tasks`, `register_alert_webhook`, even
  `issue_household_token` itself). The enforcement point is a single wrapper (`src/rbac.ts`) around
  `McpServer#registerTool`, applied once at session-creation time for a read-only session and never touching any
  individual tool file — it reuses the `readOnlyHint` annotation every tool already declares (for an unrelated
  reason, since round 2) rather than hand-adding a role check to a dozen handlers. Round 4's exact "no token or
  unrecognized token" behavior is unchanged: only a token this server actually issued (via `issue_household_token`)
  carries a role at all; every other token still gets hash-derived, full-access, no-pre-registration-required
  treatment.
- **Outbound household-alert webhooks.** `register_alert_webhook` lets a household register a callback URL to be
  proactively notified — no MCP session needs to be open to receive these — when `add_expense` pushes a category
  over its weekly budget, or when a task operation (`add_task`, `import_tasks`, `sync_household_calendar`) reveals
  something overdue. Mirrors, in spirit, this repo's `ring-porchpass`/`firetv-courtside` outbound-webhook pattern:
  payloads are signed with HMAC-SHA256 (header `X-HomeOps-Signature`, over the raw JSON body) using a secret handed
  back exactly once at registration, and delivery retries up to 3 times with exponential backoff before giving up
  and logging a warning via the MCP logging capability. Delivery is fire-and-forget by construction — the tool call
  that triggered the alert returns immediately, never blocked on a slow or unreachable endpoint — and
  `get_alert_webhook_status` reports the outcome of the most recent attempt (never the secret) for observability.
- **Recurring/template tasks.** `add_recurring_task` adds a weekly chore template (`daysOfWeek: number[]`, e.g.
  `[2]` for every Tuesday) instead of a one-off task with a single due date. No per-occurrence row is ever stored:
  `list_upcoming_tasks` materializes the actual occurrences on read, one per matching weekday within whatever
  `withinDays` window is requested, each with its own synthetic ID (`${templateId}:${date}`) — so "take out the
  trash every Tuesday" survives across weeks without a background job re-adding it, and a 30-day lookahead shows
  every occurrence that falls in that window in one `list_upcoming_tasks` call.
- **Household digest export.** `export_household_digest` produces one combined text report — upcoming tasks,
  budget status, low-stock items, and proactive anomaly flags — for a household member to read at a glance, save,
  or share. Its summary paragraph reuses the exact same sampling-backed narrative generation `generate_weekly_narrative`
  and `run_morning_briefing` already use (falling back to the same kind of templated summary when the client doesn't
  support MCP sampling), and its anomaly section reuses `get_proactive_alerts`' exact detection logic, rather than
  duplicating either.

### Household copilot features (round 6)

These four are the genuinely new *capabilities* this round adds — not more infrastructure hardening, but things a
household would actually want that didn't exist in any form before, each wired for real against the same store
every other tool already shares (no shadow data model, no stubs).

- **Smart meal planner (`suggest_meal_plan`).** The one genuinely new cross-tool orchestration in this round: it
  reads `itemsRunningLow` (what's about to run out — bias meal choice toward using it up instead of buying more),
  `getBudgetStatusFor(householdId, "groceries")` (what's actually left to spend this week), and `listUpcomingTasks`
  (which of the next N days already has something due — those get a quick meal, not an hour-long recipe) and turns
  all three into a day-by-day plan against a small built-in meal catalog, capping total estimated cost at the real
  remaining budget rather than a guess. No single existing tool could answer "what should we eat this week" — it's
  a genuinely new combination of data three different domains already track.
- **Chore-to-allowance ledger (`set_task_reward`, `get_allowance_balance`, `record_allowance_payout`).** Extends the
  existing fair-chore-assignment system instead of building a second, parallel task concept: any task can carry an
  optional `rewardAmount` (set independently of creation, so an existing chore can be turned into a paid one), and
  `mark_task_done` — the one place "this chore just got done" is already known — credits that amount to the task's
  `assignee` the moment it completes, into a running per-member balance that accumulates until explicitly paid out.
  Ties the chore-rotation system and the expense-tracking concept together in a way neither does alone.
- **Freeform capture / dispatcher tool (`capture_note`).** The front door for one unstructured sentence a household
  member might actually say to Alexa+ — "we're almost out of coffee and I need to pick up dry cleaning by Friday" —
  instead of requiring the caller to already know which of `add_task`/`reorder_item`/`add_expense` to call. Uses the
  exact same MCP-sampling pattern `generate_weekly_narrative` already uses (no bundled model key) to ask the
  connected client's own model to classify the note as strict JSON (shopping/task/expense), then dispatches into the
  matching *existing* store function — never a fourth, competing way to create any of those records. Falls back to
  treating the whole sentence as a task (rather than losing it) both when the client doesn't support sampling at
  all, and when it does but its response can't be parsed as valid classification JSON.
- **Proactive household digest with anomaly flags (`get_proactive_alerts`, and folded into `export_household_digest`).**
  Every existing read tool answers a direct question ("what's due", "are we over budget *right now*", "what's low
  *right now*"). This answers a question nobody asked: is anything trending toward a problem. Three detectors, all
  reading data other tools already expose (`src/anomalies.ts`, no new persisted state) — a task-load pileup on one
  member relative to the least-loaded one; a budget category that isn't over budget yet but whose spend-so-far,
  projected out at its current pace (spend so far ÷ days since its first expense this rolling week × 7), is on track
  to land well over it; and a low-stock item that's been sitting low for a long stretch (or has never been
  reordered at all) without being restocked. `export_household_digest` reuses the identical detection function for
  its own "WORTH ATTENTION" section rather than a second copy.

## Language models: MCP sampling first, Claude on Amazon Bedrock second

Four tools need a language model: `generate_weekly_narrative`, `run_morning_briefing`, `export_household_digest`
(narration) and `capture_note` (classifying a freeform sentence). They all go through one function,
`generateText()` in [`src/llm.ts`](./src/llm.ts), which tries in order:

1. **The connected client's own model via MCP sampling.** It costs this server nothing and is the protocol's
   preferred path, so it always wins when the client declares the `sampling` capability.
2. **Claude on Amazon Bedrock** (`anthropic.claude-opus-5-5` by default), when `HOMEOPS_USE_BEDROCK=true`. This
   matters because not every MCP client supports sampling. Without it, every one of those tools would fall back to
   templated text. Calls go through the Bedrock Mantle client (`@anthropic-ai/bedrock-sdk`) with standard AWS
   credentials, a 20-second timeout (a voice turn can't wait longer), and `effort: "low"` (these are short tasks).
   A refusal is retried on `anthropic.claude-opus-4-8` via the SDK's refusal-fallback middleware.
3. **A templated answer** built from the same data, so the tool still responds if neither model is available or
   Bedrock errors.

`capture_note`'s structured output reports which path classified the note (`classifiedBy`:
`sampling` / `bedrock` / `fallback`).

## Voice tool profile

The full server exposes 25 tools, including admin and setup tools (tokens, webhooks, bulk import, budgets,
allowance rules). Every extra tool an agent has to choose between makes a wrong pick likelier, so
`HOMEOPS_TOOL_PROFILE=voice` exposes only the 12 a household member would ask a voice assistant for
(`src/toolProfile.ts`): `run_morning_briefing`, `capture_note`, `list_upcoming_tasks`, `add_task`,
`mark_task_done`, `add_recurring_task`, `list_low_stock_items`, `reorder_item`, `add_expense`,
`get_budget_status`, `get_proactive_alerts`, `suggest_meal_plan`. The other tools are registered but disabled, so
they don't appear in `tools/list` and can't be called. The deploy script sets this profile for the Alexa+ endpoint.

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
no token), each independently loaded/saved from its own file. A token minted by `issue_household_token` also gets
an entry in `data/_tokens.json` (the same directory, same write-then-rename discipline) mapping its hash to the
household + role it was issued for — that registry, not the household files, is what makes a read-only token for
an existing household possible at all (see "Role-based access control" above). Alert-webhook delivery *status*
(last attempt/success/error) is the one piece of round-5 state that is intentionally **not** persisted — it's
process-lifetime observability only, the same tradeoff round 4 made for the reorder-idempotency cache.

Round 6 adds one new field to the same per-household JSON file rather than a separate store: `allowanceBalances`
(a `member -> running balance` map, credited by `mark_task_done` when a task carries a `rewardAmount`). It's
optional on the `Household` type and every reader defaults a missing map to `{}`, so a household file written by an
earlier round still loads without a migration step.

## Project layout

```
src/
  index.ts        Express app + Streamable HTTP transport; extracts the bearer token per session and resolves
                  it to a household ID + access role (src/auth.ts) before creating that session's McpServer
  auth.ts          extractBearerToken(), resolveHouseholdId() (round 4, hash-only), and resolveAccess()/
                   issueToken() (round 5's role-aware lookup + a small on-disk token registry)
  rbac.ts          restrictToReadOnlyTools() — wraps McpServer#registerTool so a read-only session's write
                   tools reject with a clear error, without touching any individual tool file
  server.ts        createHomeOpsServer(householdId, role, profile) factory — wires resources, prompts, and all
                   tools onto a fresh McpServer scoped to one household (and access role), logging capability declared
  llm.ts           generateText() — MCP sampling first, then Claude on Amazon Bedrock (BedrockTextModel, with
                   refusal fallback), else undefined so callers use their templated answer
  toolProfile.ts   applyToolProfile() — the "voice" profile disables admin/setup tools for Alexa+
  store.ts         File-backed household data (tasks, shopping, expenses, budgets, alert webhook registration),
                   one JSON file per household ID under data/ (HOMEOPS_DATA_DIR-overridable), atomic
                   write-then-rename + fair-rotation/budget/idempotency logic + bulk import + recurring-task
                   materialization + overdue-task lookup
  webhookDelivery.ts  fireHouseholdAlert() — HMAC-SHA256-signed outbound webhook delivery with retry/backoff
  logging.ts       logEvent() helper over the MCP logging capability (notifications/message)
  resources.ts     homeops:// resources + subscribe/unsubscribe + notify() helper for push updates, scoped by
                   household ID
  eventStore.ts    InMemoryEventStore — Streamable HTTP resumability (replay after a dropped connection)
  prompts.ts       weekly_household_briefing prompt template
  mealPlanner.ts   buildMealPlan() — pure planning logic for suggest_meal_plan, reading low-stock/budget/task
                   data from store.ts and combining it against a small built-in meal catalog; no store writes
  anomalies.ts     computeHouseholdAnomalies() (+ the three individual detectors) for get_proactive_alerts and
                   export_household_digest's WORTH ATTENTION section — reads existing store data, no new state
  types.ts         Shared data model, including RecurrenceRule, AlertWebhookRegistration, AccessRole,
                   Task.rewardAmount, Household.allowanceBalances
  tools/
    tasks.ts       list_upcoming_tasks, add_task, add_recurring_task, import_tasks, mark_task_done (also credits
                   an allowance reward if one was set), suggest_assignee, sync_household_calendar (the last two
                   also fire overdue-task alerts)
    shopping.ts    list_low_stock_items, reorder_item (elicitation-backed, idempotency-key protected)
    expenses.ts    add_expense, get_weekly_summary, set_budget, get_budget_status — plus applyExpenseFollowUps(),
                   the shared over-budget-check/log/webhook logic add_expense and capture_note's expense branch
                   both call, so that behavior lives in exactly one place
    insights.ts    generate_weekly_narrative, run_morning_briefing, get_proactive_alerts, export_household_digest
                   (model-backed narration via llm.ts + compound orchestration + anomaly detection + combined
                   report, sharing one sampleNarrative() helper and one computeHouseholdAnomalies() call)
    access.ts      issue_household_token — mint a full-access or read-only token for this household
    webhooks.ts    register_alert_webhook, get_alert_webhook_status
    mealPlan.ts    suggest_meal_plan — thin tool wrapper around mealPlanner.ts's buildMealPlan()
    allowance.ts   set_task_reward, get_allowance_balance, record_allowance_payout (the chore-to-allowance ledger)
    capture.ts     capture_note — model-backed classification + dispatch into shopping/task/expense, reusing
                   reportLowStock/addTask/addExpense and expenses.ts's applyExpenseFollowUps rather than a new path
data/              JSON-file-backed household storage, one file per household ID, plus _tokens.json (the
                   role-aware token registry) — gitignored, created on first use
test/
  smoke.test.ts    End-to-end test: real MCP client + server, exercising every tool, resource (+ template,
                   completion, subscribe/notify), prompt, elicitation round-trip, sampling call,
                   progress-streaming tool call, idempotent retry, compound tool, a direct EventStore unit
                   test, bearer-token household isolation, structured logging notifications, file-backed
                   persistence across a simulated restart, bulk task import, recurring-task materialization
                   across multiple weeks, the household digest export, read-only token enforcement,
                   HMAC-signed webhook delivery against a real local HTTP listener, the chore-to-allowance
                   ledger, capture_note's shopping/task/expense routing (plus its two fallback paths),
                   suggest_meal_plan's budget/low-stock/busy-day cross-referencing, and proactive anomaly
                   detection (task pileup, spending-pace trend, stale low stock), Claude on Bedrock behind
                   the model-backed tools (real SDK requests to a fake Mantle endpoint, including the
                   refusal fallback and error degradation), and the voice tool profile
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

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3333` | HTTP port |
| `HOMEOPS_DATA_DIR` | `./data` | Where household JSON files are stored |
| `HOMEOPS_TOOL_PROFILE` | `full` | `voice` exposes only the 12 household tools (see "Voice tool profile") |
| `HOMEOPS_USE_BEDROCK` | unset | `true` enables Claude on Amazon Bedrock for clients that can't sample |
| `HOMEOPS_BEDROCK_MODEL` | `anthropic.claude-opus-5-5` | Bedrock model ID to call |
| `AWS_REGION` | — | Bedrock region; AWS credentials come from the standard AWS chain (env, profile, or an ECS task role) |

The Bedrock caller needs the `bedrock-mantle:CreateInference` permission (the AWS managed policy
`AmazonBedrockMantleInferenceAccess` covers it) and access to the model in that region.

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

### Issuing a read-only token (role-based access control)

Every token above connects `full-access` by default (unchanged from round 4). To hand out a token that can only
call read tools — a kid's device, a shared kitchen display, a dashboard — call `issue_household_token` from a
full-access session already connected to the household you want to scope it to:

```jsonc
// tools/call issue_household_token { "role": "read-only" }
// -> structuredContent: { "token": "<hex>", "role": "read-only", "householdId": "home-1" }
```

Connect a second client with `Authorization: Bearer <that token>` and it lands on the *same* household, but every
write tool (`add_task`, `reorder_item`, `add_expense`, `import_tasks`, `add_recurring_task`,
`register_alert_webhook`, even `issue_household_token` itself) responds with `isError: true` and a message naming
the token as read-only, instead of either silently succeeding or silently doing nothing. Read tools
(`list_upcoming_tasks`, `get_budget_status`, `list_low_stock_items`, `export_household_digest`, ...) work exactly
as they would for a full-access token.

### Registering an alert webhook

```jsonc
// tools/call register_alert_webhook { "url": "https://your-endpoint.example/homeops-alerts" }
// -> structuredContent: { "url": "...", "secret": "<hex, shown once>", "createdAt": "..." }
```

From then on, an over-budget `add_expense` or an overdue task surfaced by `add_task`/`import_tasks`/
`sync_household_calendar` POSTs a signed JSON payload to that URL:

```
POST https://your-endpoint.example/homeops-alerts
X-HomeOps-Signature: <hex HMAC-SHA256 of the raw body, using the secret above>
X-HomeOps-Alert-Type: budget_exceeded | task_overdue
Content-Type: application/json

{"type":"budget_exceeded","householdId":"home-1","message":"...","data":{...},"firedAt":"..."}
```

Verify it the same way `ring-porchpass`'s Ring-event ingress verifies inbound signatures — recompute
`HMAC-SHA256(secret, rawBody)` and compare — just in the opposite direction, since here HomeOps is the sender.
`get_alert_webhook_status` reports the outcome of the most recent delivery attempt without ever re-exposing the
secret.

### Trying the household copilot features

```jsonc
// tools/call suggest_meal_plan { "days": 3 }
// -> structuredContent: { days: [{ date, meal, quickMeal, busyDay, estCost, usesLowStockItems }, ...],
//                          totalEstCost, groceryBudgetRemaining, withinBudget, lowStockConsidered, busyDayCount }

// tools/call set_task_reward { "taskId": "<id from list_upcoming_tasks>", "amount": 2.5 }
// tools/call mark_task_done { "taskId": "<same id>" }
// -> text includes "Jordan earned 2.50 (allowance balance: 2.50)."
// tools/call get_allowance_balance {}                       // every member's balance
// tools/call record_allowance_payout { "member": "Jordan" } // pays out (and zeroes) the full balance

// tools/call capture_note { "text": "we're almost out of coffee and I need to pick up dry cleaning by Friday" }
// -> classifies via MCP sampling and routes to reportLowStock/addTask/addExpense; structuredContent names
//    which one (routedTo) and whether sampling was actually used (usedSampling)

// tools/call get_proactive_alerts {}
// -> structuredContent: { anomalies: [{ type, severity, message, data }, ...], count }
```

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
`notifications/message` log entries. It then adds a recurring task and confirms it materializes into distinct,
correctly-spaced occurrences across a two-week `list_upcoming_tasks` window; exports a household digest and checks
its tasks/budget/low-stock sections against the equivalent individual tool calls; mints a read-only token via
`issue_household_token` and confirms that token can list tasks but is rejected — with a clear error, and no actual
effect — when it calls `add_task`; and registers an alert webhook against a real local `http` listener spun up in
the test process, then verifies a subsequent over-budget expense (and a subsequent already-overdue `add_task`)
each deliver a payload to it whose `X-HomeOps-Signature` header is exactly the HMAC-SHA256 the test independently
recomputes from the secret `register_alert_webhook` returned. It then exercises all four round-6 features: sets a
reward on a task, marks it done, and confirms the assignee's allowance balance is credited and then zeroed by a
payout; sends several freeform sentences through `capture_note` and confirms each lands in the right place
(shopping, task-with-a-due-date, expense) via a scripted mock "model" keyed off the sentence, plus confirms the
fallback-to-task behavior both when the mocked model's reply isn't valid classification JSON and when a second
client connects with no sampling capability at all; calls `suggest_meal_plan` and checks its plan actually reflects
the real remaining groceries budget and the low-stock items `capture_note` just added; and forces a task-load
imbalance and an over-pace (but not yet over-budget) spending category, then confirms `get_proactive_alerts` flags
all three anomaly types (including the never-reordered low-stock items) and that `export_household_digest`'s
WORTH ATTENTION section reflects the same findings. It then connects two more clients under two different bearer
tokens and confirms their household data is completely isolated, and finally spins up two independent server
instances pointed at the same on-disk data directory to confirm a household's data survives a simulated restart.
No external services required.

You can also point the [MCP Inspector](https://modelcontextprotocol.io/legacy/tools/inspector) at the running
server for interactive exploration:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3333/mcp
```

## Wiring it up to Alexa+

1. Run the server somewhere reachable over HTTPS. `../deploy/deploy.sh alexa-homeops-mcp` from AWS CloudShell
   gives you a public HTTPS endpoint on Amazon ECS Express Mode, already configured with the voice tool profile and
   Bedrock (see [`../deploy/README.md`](../deploy/README.md)). For a quick local demo, a tunnel like
   `ngrok http 3333` with `HOMEOPS_TOOL_PROFILE=voice` also works.
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
   - "Take out the trash every Tuesday" (`add_recurring_task`; shows up in every future week's task list)
   - "Give me the full household report" (`export_household_digest` — tasks, budget, and low stock in one report)
   - "Set up a read-only token for the kitchen display" (`issue_household_token` with `role: "read-only"`)
   - "Notify me at this URL if we go over budget or something's overdue" (`register_alert_webhook`)
   - "What should we eat for the next few days?" (`suggest_meal_plan` — uses up what's running low, fits the budget)
   - "The trash chore is worth two dollars" → *(kid takes out the trash, marks it done)* → "How much have I earned?"
     (`set_task_reward` → `mark_task_done` credits it → `get_allowance_balance` / `record_allowance_payout` to settle up)
   - "We're almost out of coffee and I need to pick up dry cleaning by Friday" (`capture_note` — one sentence, no
     need to say which tool handles it)
   - "Is there anything I should know about?" (`get_proactive_alerts` — surfaces what nobody explicitly asked about)

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
  auth is threaded from the HTTP layer into per-session state the same way a real multi-tenant MCP server would,
  now carrying an access role as well as a household ID, and enforced by wrapping the SDK's own tool-registration
  API rather than hand-checking a role in every handler. Outbound alert delivery reuses the exact HMAC-SHA256 +
  retry-with-backoff pattern this repo's other services (`ring-porchpass`, `firetv-courtside`) use for their own
  webhooks, applied in the opposite (outbound) direction. Round 6 adds a fifth genuine MCP-sampling consumer
  (`capture_note`, classifying freeform text into strict JSON rather than just narrating data), and two modules
  (`mealPlanner.ts`, `anomalies.ts`) that orchestrate *across* the existing store instead of adding a new isolated
  data domain. Claude on Amazon Bedrock backs the model-dependent tools for clients that can't sample, with
  refusal fallback and a hard timeout, deployed with a least-privilege task role (AWS Builder mini-challenge).
- **Design:** Tools are scoped and composable so the agent can chain them (check → decide → act), with
  `run_morning_briefing` collapsing the common four-tool chain into one round trip for latency-sensitive voice
  interactions, `import_tasks` collapsing a whole batch of adds into one round trip and one notification, and
  `export_household_digest` collapsing the same three-domain check (now four, with anomalies) into one shareable
  report. The one spending tool (`reorder_item`) confirms through the protocol's own elicitation mechanism and is
  safe to retry via an idempotency key, and every capability degrades gracefully when a client doesn't support it —
  `capture_note` is the clearest new example, falling back to "just add it as a task" rather than erroring both
  when sampling isn't supported and when the model's answer can't be parsed.
- **Potential Impact:** A genuinely useful daily-use pattern (household coordination, fair chore-splitting, budget
  awareness) rather than a novelty demo, with production-grade concerns actually handled — safe retries on the
  spending path, connection resumability, per-household data isolation via bearer tokens, data that survives a
  restart, least-privilege access for household members who shouldn't be able to spend or edit, and proactive
  alerts that don't require an open session to receive — not just a happy-path demo. Recurring tasks close a real
  daily-use gap (nobody re-adds "take out the trash" every single week by hand). Round 6's four features are the
  ones squarely aimed at *this* criterion specifically: a meal plan that actually accounts for what's already
  running low and what's left in the budget, an allowance system that makes fair chore-splitting mean something to
  a kid, a capture tool that removes the "which tool do I even use" friction entirely, and anomaly flags that
  surface a problem before anyone has to go looking for it. The remaining hackathon-specific shortcuts are the
  persistence layer (a JSON file per household, no real database) and the in-memory token/webhook delivery-status
  registries — explicitly documented as such, not hidden.
- **Quality of Idea:** Demonstrates multi-tool agentic orchestration *and* deep MCP protocol usage (resources with
  live push updates, sampling instead of a bundled model key, resumable transport, idempotent writes, structured
  logging as a first-class observability channel, and now role-aware tool registration plus signed outbound
  webhooks) — the actual differentiators between an "Agent Skill" and a legacy single-intent Alexa Skill. Round 6 is
  where that orchestration stops being purely infrastructural: `suggest_meal_plan` genuinely combines three
  domains' data into an answer no single tool could give, and `capture_note` removes the requirement that the
  caller already know the server's tool taxonomy at all.

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
judging bonus).
