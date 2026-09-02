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
| `mark_task_done` | Mark a task complete |
| `suggest_assignee` | Recommend who should take the next chore, by current open-task load |
| `list_low_stock_items` | Items running low that might need reordering |
| `reorder_item` | Reorder an item — confirms via **MCP elicitation** before spending |
| `add_expense` | Log a household expense; warns if it pushes a category over budget |
| `get_weekly_summary` | Total spend by category over the past 7 days |
| `set_budget` / `get_budget_status` | Set and check weekly budgets per category |
| `generate_weekly_narrative` | Turn the week's data into a natural-language digest via **MCP sampling** |
| `sync_household_calendar` | Sync tasks to a shared calendar, streaming **progress notifications** per task |

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

The server holds a single demo household in memory, seeded with sample tasks and shopping items on startup — enough
to drive a live demo without a database. Swapping in per-user persistence would mean keying `src/store.ts` off the
caller's identity instead of a single in-memory object.

## Project layout

```
src/
  index.ts        Express app + Streamable HTTP transport, one MCP session per conversation
  server.ts        createHomeOpsServer() factory — wires resources, prompts, and all tools onto a fresh McpServer
  store.ts         In-memory household data (tasks, shopping, expenses, budgets) + fair-rotation/budget logic
  resources.ts     homeops:// resources + subscribe/unsubscribe + notify() helper for push updates
  prompts.ts       weekly_household_briefing prompt template
  types.ts         Shared data model
  tools/
    tasks.ts       list_upcoming_tasks, add_task, mark_task_done, suggest_assignee, sync_household_calendar
    shopping.ts    list_low_stock_items, reorder_item (elicitation-backed confirmation)
    expenses.ts    add_expense, get_weekly_summary, set_budget, get_budget_status
    insights.ts    generate_weekly_narrative (MCP sampling)
test/
  smoke.test.ts    End-to-end test: real MCP client + server, exercising every tool, resource (+ template,
                   completion, subscribe/notify), prompt, elicitation round-trip, sampling call, and
                   progress-streaming tool call
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

## Testing

```bash
npm test
```

This starts the server on an ephemeral port, connects a real MCP `Client` over `StreamableHTTPClientTransport`
(with elicitation- and sampling-handling stubs wired in), and drives a full scenario: list tools/resources/prompts →
get a fair-rotation suggestion → add a task and confirm its resource-update notification arrives → reorder an item
through a live elicitation round-trip → log an expense and see the over-budget warning → generate a
sampling-backed narrative. No external services required.

You can also point the [MCP Inspector](https://modelcontextprotocol.io/legacy/tools/inspector) at the running
server for interactive exploration:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3333/mcp
```

## Wiring it up to Alexa+

1. Run the server somewhere reachable over HTTPS (a tunnel like `ngrok http 3333` works for local demos).
2. In the Alexa+ Agent Skill / web app simulator, register the MCP server endpoint (`https://<host>/mcp`).
3. Try prompts such as:
   - "What's due around the house this week?"
   - "Who should take out the trash?" (fair chore rotation)
   - "Is anything running low?" → "Yes, go ahead and reorder the dog food" (Alexa+ surfaces the elicitation form)
   - "Log $60 for dog food under pets" (triggers the over-budget warning if the pets budget is set below that)
   - "Give me the weekly household briefing" (uses the `weekly_household_briefing` prompt + sampling-backed digest)
   - "Sync my tasks to the calendar" (streams progress notifications as each task syncs)

## Judging-criteria alignment

- **Tech Implementation:** Real Streamable HTTP MCP transport (2025-11-25+ spec) with proper session lifecycle
  (`Mcp-Session-Id` header, per-session `McpServer` instances, session cleanup on close) — plus resources (including
  a completable resource template), prompts, elicitation, sampling, structured tool output, tool annotations, and
  progress notifications: essentially the full breadth of the MCP spec rather than tools alone.
- **Design:** Tools are scoped and composable so the agent can chain them (check → decide → act); the one
  state-changing/spending tool (`reorder_item`) confirms through the protocol's own elicitation mechanism rather
  than a bespoke flag, and every capability degrades gracefully when a client doesn't support it.
- **Potential Impact:** A genuinely useful daily-use pattern (household coordination, fair chore-splitting, budget
  awareness) rather than a novelty demo — the in-memory store is the only hackathon-specific shortcut; the tool,
  resource, and prompt surface is production-shaped.
- **Quality of Idea:** Demonstrates multi-tool agentic orchestration *and* deep MCP protocol usage (resources with
  live push updates, sampling instead of a bundled model key) — the actual differentiators between an "Agent
  Skill" and a legacy single-intent Alexa Skill.

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
judging bonus).
