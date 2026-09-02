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
| `add_task` | Add a task with a due date and optional assignee |
| `mark_task_done` | Mark a task complete |
| `list_low_stock_items` | Items running low that might need reordering |
| `reorder_item` | Reorder an item — **previews first**, only executes with `confirm: true` |
| `add_expense` | Log a household expense with an amount and category |
| `get_weekly_summary` | Total spend by category over the past 7 days |

**Design note:** `reorder_item` is a spending action, so it never buys anything on the first call. It returns a
preview ("X has Y on hand, confirm the reorder?") and only restocks once called again with `confirm: true` —
mirroring how Alexa+ should confirm with the user before it takes a real-world, money-spending action.

The server holds a single demo household in memory, seeded with sample tasks and shopping items on startup — enough
to drive a live demo without a database. Swapping in per-user persistence would mean keying `src/store.ts` off the
caller's identity instead of a single in-memory object.

## Project layout

```
src/
  index.ts        Express app + Streamable HTTP transport, one MCP session per conversation
  server.ts        createHomeOpsServer() factory — registers all tools on a fresh McpServer
  store.ts         In-memory household data (tasks, shopping items, expenses) + seed data
  types.ts         Shared data model
  tools/
    tasks.ts       list_upcoming_tasks, add_task, mark_task_done
    shopping.ts    list_low_stock_items, reorder_item
    expenses.ts    add_expense, get_weekly_summary
test/
  smoke.test.ts    End-to-end test: spins up the server, connects a real MCP client, exercises every tool
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

This starts the server on an ephemeral port, connects an MCP `Client` over `StreamableHTTPClientTransport`, lists
the tools, and drives a full scenario (check tasks → spot low stock → preview a reorder → confirm it → log an
expense → pull the weekly summary). No external services required.

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
   - "Is anything running low?" → "Yes, go ahead and reorder the dog food" (exercises the preview → confirm flow)
   - "Log $42.50 for dog food under pets"
   - "How are we doing on spending this week?"

## Judging-criteria alignment

- **Tech Implementation:** Real Streamable HTTP MCP transport (2025-11-25+ spec) with proper session lifecycle
  (`Mcp-Session-Id` header, per-session `McpServer` instances, session cleanup on close).
- **Design:** Tools are scoped and composable so the agent can chain them (check → decide → act), and the one
  state-changing/spending tool (`reorder_item`) requires an explicit confirmation step rather than acting silently.
- **Potential Impact:** A genuinely useful daily-use pattern (household coordination) rather than a novelty demo —
  the in-memory store is the only hackathon-specific shortcut; the tool surface itself is production-shaped.
- **Quality of Idea:** Demonstrates multi-tool agentic orchestration, the actual differentiator between an "Agent
  Skill" and a legacy single-intent Alexa Skill.

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
judging bonus).
