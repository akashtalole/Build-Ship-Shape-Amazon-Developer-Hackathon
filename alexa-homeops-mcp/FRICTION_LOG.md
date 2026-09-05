# Friction Log — HomeOps MCP Server

Notes captured while building the Alexa+ HomeOps submission, for the hackathon's optional friction-log bonus.

## What worked well

- `McpServer.registerTool()` with a Zod raw-shape `inputSchema` is genuinely low-friction: schema validation,
  JSON-Schema generation for the model, and typed handler arguments all come for free from one declaration.
- The Streamable HTTP transport's session model (one `Mcp-Session-Id` header, one transport per session) mapped
  cleanly onto a standard Express routing pattern — no custom protocol plumbing needed.
- Writing the smoke test against a real `Client` + `StreamableHTTPClientTransport` (rather than mocking) caught
  real issues (see below) in minutes that unit tests against the tool functions directly would have missed.

## Friction encountered

1. **SDK package split is easy to trip over.** The MCP TypeScript SDK is mid-migration from a single
   `@modelcontextprotocol/sdk` package (stable, v1.x) to a split set of `@modelcontextprotocol/{server,client,node,express}`
   packages (v2, still alpha at time of writing). Docs and examples for both generations are mixed together, so it's
   easy to copy an import path (`@modelcontextprotocol/server`) that doesn't match the package actually installed
   (`@modelcontextprotocol/sdk`). **Ask:** a clear "which generation are you on" banner at the top of the docs site,
   or at minimum consistent version tagging on every code sample, would save real debugging time.
2. **No first-party guidance on confirming state-changing tools.** The spec has no built-in notion of "this tool
   spends money, ask before executing" — that had to be modeled by hand (a `confirm` boolean parameter and a
   preview-vs-execute branch in the handler). This is a common enough pattern (any purchase/delete/send action) that
   a documented convention or SDK helper would likely improve consistency across third-party MCP servers.
3. **Simulating Alexa+ locally requires a public HTTPS endpoint.** For local iteration before wiring up the real
   Alexa+ web app simulator, a tunnel (ngrok or similar) was the only practical option, which adds a moving part to
   the inner dev loop compared to testing against the MCP Inspector directly.
4. **`outputSchema` mismatches fail at call time, not registration time.** Declaring `outputSchema` and then
   returning `structuredContent` with one extra field (in our case, forgetting `done` on a `Task`) doesn't error
   until a client actually calls the tool — the SDK doesn't validate that the schema and the handler's return
   shape agree when you register it. A `tsc`-time or registration-time check comparing the inferred return type
   against `outputSchema` would have caught this instantly instead of via a failing integration test.
5. **Testing Streamable HTTP resumability end-to-end is inherently manual.** The high-level `Client` class owns
   the standalone SSE stream itself and reconnects transparently, which is great for real usage but makes it hard
   to *observe* a drop-and-replay from the outside without bypassing the SDK's client entirely. We ended up
   unit-testing the `EventStore` class directly (fast, deterministic) and separately verifying the full HTTP
   behavior by hand with raw `curl` (see the README's "Verifying resumability by hand" section) — a documented,
   scriptable way to simulate a mid-session drop from the client side would make this testable in CI too.

## Feature requests

- A lightweight "confirmation required" annotation on `registerTool` metadata that clients (including Alexa+) could
  surface consistently, instead of every server inventing its own preview/confirm convention.
- An official local-simulator mode for Alexa+ that doesn't require exposing a public HTTPS URL for early iteration.
- A registration-time (or `tsc`-time) check that a tool's declared `outputSchema` actually matches what its handler
  returns, instead of only surfacing a mismatch as a runtime `tools/call` error.
- A documented way to simulate a dropped Streamable HTTP connection from `StreamableHTTPClientTransport` itself
  (not just from a raw `fetch`), so resumability behavior is testable through the SDK's own client.

## Round 4: multi-tenancy, logging, persistence, bulk import

6. **MCP tool handlers never see raw HTTP headers, so auth has to be threaded through by hand.** A tool's handler
   gets typed arguments and an `extra` object with things like the progress token and `sendNotification` — nothing
   from the HTTP request itself. The only place `Authorization` is actually visible is the Express route handler in
   `index.ts`, before the transport/`McpServer` for that session even exists. That forced a specific shape: resolve
   the household ID once, right there, and pass it as a plain constructor argument into `createHomeOpsServer(householdId)`,
   which then closes over it into every tool/resource registration. This works cleanly for Streamable HTTP's
   one-`McpServer`-per-session model, but it's a pattern you have to arrive at yourself — there's no SDK-level
   concept of "per-session context" a tool handler can just ask for. **Ask:** even a documented convention (let alone
   an SDK helper) for "here's how a tool can access request-scoped data set at session-initialize time" would save
   every self-hosted MCP server from re-deriving this same closure pattern.
7. **Finding the logging notification API meant reading the SDK's compiled output, not searching docs.** `sendLoggingMessage`
   doesn't show up prominently in the MCP spec's own docs (which describe `notifications/message` at the protocol
   level, not the SDK method name), so the fastest path was `grep`-ing `node_modules/@modelcontextprotocol/sdk` for
   "logging" directly and reading `server/index.d.ts`. That also surfaced a non-obvious gotcha: `sendLoggingMessage`
   silently no-ops unless the `McpServer` was constructed with `capabilities: { logging: {} }` — there's no error,
   no warning, the notification just never goes out. Easy to write a "logging" feature that quietly does nothing if
   you don't happen to declare the capability first.
8. **Deciding what "no in-memory cache" costs, and choosing it anyway.** The obvious way to add persistence without
   disturbing every store function's signature (load-once into a module-level object, same as before, just now
   hydrated from disk at startup) reintroduces exactly the "two instances share stale state" problem the
   restart-durability requirement is testing for: two `createHomeOpsServer()` calls in the same process would just
   read the same cached object and never re-touch the file the *other* one wrote. Reading and writing the household
   file fresh on every store call (no cache at all) sidesteps that entirely and is simple to reason about, at the
   cost of a stat+read (and a stat+write+rename on every mutation) per call — a real tradeoff, acceptable at this
   scale, worth stating rather than discovering later as a subtle bug when someone *does* add caching back in.
9. **Atomic-write edge case: the temp filename itself needs to not collide.** The obvious `${file}.tmp` temp path
   works fine for one household with one writer, but two near-simultaneous mutations to the *same* household
   (unlikely in this demo, not impossible if an agent double-calls a tool) could race on the same temp file. Using
   `${file}.${pid}.${randomUUID()}.tmp` costs nothing and removes that class of collision entirely — a small thing,
   but the kind of detail that's easy to skip when "atomic write" gets treated as a checkbox rather than as an
   actual multi-writer scenario worth thinking through.
10. **Shaping `import_tasks`'s per-item result meant deliberately *not* using a strict Zod `inputSchema` for the
    array items.** The natural first instinct — `items: z.array(z.object({ title: z.string().min(1), dueDate: z.string() }))`
    — validates cleanly, but a schema violation on *any* array element rejects the *entire* `tools/call` at the
    protocol layer, before the handler ever runs, which makes per-item "added vs. rejected, and why" results
    impossible: a bad item doesn't get a reason, the whole batch just errors out. The fix was to accept each item
    loosely (`z.unknown().optional()` per field) and hand-validate title/date-format inside the handler instead —
    less type safety at the schema boundary, but the tradeoff a "graceful partial failure" tool actually requires.

## Round 5: role-based access control, outbound alert webhooks, recurring tasks, digest export

11. **Enforcing a role against a dozen already-written tools without touching any of them.** The obvious way to add
    "reject writes for a read-only token" is to add an `if (role === "read-only") return {isError:true,...}` line to
    the top of every write handler in `tasks.ts`, `shopping.ts`, `expenses.ts`, plus every new write tool this same
    round adds (`add_recurring_task`, `register_alert_webhook`, `issue_household_token`) — a dozen-plus near-identical
    checks, easy to forget on the next new tool anyone adds after this round. The fix (`src/rbac.ts`) was to notice
    that every tool already declares a `readOnlyHint` annotation (added in round 2, for an unrelated reason — letting
    a *client* decide what's safe to auto-approve) and wrap `McpServer#registerTool` itself once, at session-creation
    time: any tool registered with `readOnlyHint !== true` gets its handler swapped for a rejection before it's even
    stored. One wrapper, applied only for `role === "read-only"` sessions, zero lines changed in any tool file, and a
    forgotten annotation on a *future* write tool fails safe (unmarked = treated as a write and blocked) rather than
    failing open. The cost: this only works because the annotation and the actual read/write-ness of a tool have
    stayed in sync so far — nothing enforces that they always will, beyond code review.
12. **A pure hash can't give two tokens for the same household different roles.** Round 4's `resolveHouseholdId` is
    deliberately a pure function of the token (hash it, done) — that's *why* an unrecognized token "just works" with
    zero setup. But "issue a read-only token for the same household as this full-access session" needs the *reverse*
    property: two different token strings mapping to the *same* household. A pure hash of each token independently
    can't produce that (they'd hash to two different, unrelated households). The fix was a small on-disk registry
    (`data/_tokens.json`, same write-temp-then-rename discipline as household files) that only `issue_household_token`
    populates — an explicitly-minted token is looked up there first; anything not in the registry (i.e. every token
    this server has ever supported before this round) falls through to the exact same hash-derivation-plus-full-access
    behavior as before. The registry is additive, not a replacement — round 4's zero-setup story for a fresh token is
    completely unchanged.
13. **Deciding where an outbound alert actually belongs, versus where it's merely convenient to fire from.** The
    obvious place to check "is anything overdue" is inside `list_upcoming_tasks` — it already computes exactly that
    set. But that's a read-heavy tool called constantly (including, now, by a read-only token) purely to render a
    list; firing a side-effecting webhook POST from a read path felt wrong on reflection, and would mean a household
    checking its own tasks repeatedly re-alerts itself every time. Alerts were moved to the actual write paths
    instead (`add_task`, `import_tasks`, `sync_household_calendar`) — the moments something *becomes* overdue or
    *is revealed* overdue by an explicit action, not every time it's merely displayed. `add_expense`'s
    budget-exceeded alert already lived at the right spot for the same reason: it's already a write handler, not a
    query.
14. **Testing a genuinely fire-and-forget delivery without making the test flaky.** `fireHouseholdAlert` is
    deliberately never awaited by its caller (the whole point is that a slow or dead webhook endpoint can't block a
    tool call) — which means the smoke test's assertion has to happen *after* the delivery has actually landed, not
    right after the triggering `tools/call` returns. A fixed `setTimeout` (300ms) is not a real synchronization
    primitive and is the least satisfying part of this round's test — it works reliably because the test's own
    listener always answers 200 immediately (so a successful delivery finishes in one attempt, no backoff wait), but
    a slower/flakier CI environment could in principle need longer. A cleaner fix would be a small poll-until-received
    helper instead of a flat sleep; deferred here in favor of matching the existing test file's established
    `setTimeout`-then-assert idiom (already used for resource-update notifications and logging messages above it).
