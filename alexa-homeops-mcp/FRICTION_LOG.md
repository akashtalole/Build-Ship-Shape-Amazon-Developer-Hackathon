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
