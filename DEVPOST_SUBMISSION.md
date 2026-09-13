# Devpost Submission Draft — Build, Ship, Shape: Amazon Developer Hackathon

This is a draft of the text to paste into the Devpost submission form(s) at
https://amazonappdev2026.devpost.com/. Everything below is drawn from what's actually built and
tested in this repo — nothing invented. Two things Devpost requires that can't be produced in this
environment are flagged inline: the **demo video** and, if you choose to record it, live testing
against real Amazon hardware/APIs (Ring devices, a Bee wearable, a Fire TV/Vega device, Bedrock
credentials).

---

## Read this first: how to actually submit (prize eligibility)

Per the hackathon rules (`hackathon-ideas/README.md`): **a project may win at most one track prize
+ one mini-challenge prize.** This repo contains six standalone implementations — one per track
(Fire TV, Alexa+, Bee, Ring) plus both mini-challenges (AWS Builder, Open Source) — because you
asked for full coverage of every category. For actual submission, that means picking:

- **One track** as your primary entry (the strongest, most complete one), and
- **One mini-challenge** layered on top, "nearly free to add" per the rules' own advice.

**Recommendation:** submit **HomeOps (Alexa+)** as the primary track — it's the deepest
implementation (5 rounds: elicitation, sampling, resources/notifications, resumable transport,
RBAC, webhooks) and Alexa+ is one of the two $25k top-prize tracks — paired with the
**Open Source mini-challenge** (`friction-log-toolkit`, a genuinely useful standalone tool, not a
throwaway script). The other four implementations (PorchPass, CourtSide, StudyLoop, the model
router) are fully working and can each be submitted as **separate Devpost projects** if you want
to be eligible for their tracks too — Devpost allows one account to submit multiple projects to
the same hackathon; each one just needs its own project page, since a single project's prize is
capped at one track + one mini-challenge.

The sections below are written so each one is a complete, self-contained Devpost project
description — copy the one(s) you're submitting.

---

## Project 1 — HomeOps (Alexa+ track)

**Tagline:** A self-hosted MCP server that lets Alexa+ actually run your household — tasks,
shopping, budget — instead of handling one command at a time.

**Try it out:** [`alexa-homeops-mcp/`](./alexa-homeops-mcp) · repo: `akashtalole/Build-Ship-Shape-Amazon-Developer-Hackathon`

### Inspiration
Alexa+ is built to orchestrate agentic, multi-step requests — but most skills still only handle one
isolated command. We wanted to answer "what's due this week, and can you reorder anything running
low?" in one turn, which means giving Alexa+ real tools to chain together, not a single intent.

### What it does
HomeOps is a self-hosted MCP server (2025-11-25 spec, Streamable HTTP transport) exposing:
tasks (list/add/complete/fair auto-assignment), a shopping/low-stock list with elicitation-gated
reordering, expense tracking with budget alerts, a natural-language weekly digest generated via
MCP **sampling** (no bundled LLM key — it asks the connected client's own model), calendar sync
with streamed progress notifications, and a compound `run_morning_briefing` tool that chains all of
the above into one call. Round 4–5 additions add multi-household Bearer-token auth, role-based
access control (full-access vs. read-only tokens), durable file-backed persistence, MCP logging
notifications, outbound alert webhooks (HMAC-signed), and recurring task templates.

### How we built it
TypeScript + `@modelcontextprotocol/sdk`, Express for the Streamable HTTP transport, a custom
resumable `EventStore` for reconnect support, file-backed JSON persistence with atomic
write-then-rename. Every feature was built test-first against a real MCP client over real HTTP —
no mocked protocol calls.

### Challenges we ran into
Getting elicitation right: `reorder_item` calls the client's own `elicitInput()` to get real user
confirmation before spending, but not every MCP client declares that capability — it had to
gracefully fall back to a preview-then-confirm flow instead of erroring. We also hit a genuine
protocol bug ourselves: an early `outputSchema` for `run_morning_briefing` didn't match the actual
`Task` shape (missing a `done: boolean` field), caught only because the smoke test used a real
schema-validating client instead of asserting on raw text.

### Accomplishments we're proud of
Five rounds of real, tested features (not stubs) — elicitation, sampling, resumable transport,
idempotent writes, multi-tenancy, RBAC, and webhooks — all verified via `npm test` + `tsc --noEmit`
+ `npm run build` before every commit, with zero shortcuts.

### What we learned
MCP's newer primitives (elicitation, sampling, resource templates with completion, structured
output) let a server delegate exactly the parts that need a human or an LLM back to the client,
instead of the server needing its own model key or a hand-rolled confirmation flag.

### What's next
Deploy behind a real Alexa+ Agent Skill registration; swap the file-backed store for DynamoDB for
true multi-instance durability; wire real push notifications (SNS) instead of the in-repo
notifier stub.

**Built with:** typescript, node.js, express, model-context-protocol, mcp-sdk, server-sent-events,
json, docker, amazon-ecs

---

## Project 2 — PorchPass (Ring track)

**Tagline:** Time-boxed, no-app-required access passes for Ring doorbells — a dog walker or
delivery driver taps a link, not a shared code.

**Try it out:** [`ring-porchpass/`](./ring-porchpass)

### Inspiration
Homeowners need to grant one-off access (a dog walker, a contractor) but sharing a permanent door
code or app login is both insecure and awkward. PorchPass issues single-use or time-boxed passes,
correlates the visitor's arrival with a real Ring doorbell/motion event, and notifies the homeowner
— with zero app or account required on the visitor's side.

### What it does
Homeowner issues a pass (visitor, validity window, use limit) → visitor taps a magic link, no login
→ PorchPass correlates the check-in with the nearest Ring doorbell/motion event within a 5-minute
window and attaches the snapshot → homeowner is notified → full audit trail. Round 2–4 additions:
recurring passes, HMAC-signed webhook ingress from Ring, a live SSE dashboard feed, quiet hours,
rate limiting, outbound signed webhooks with retry, bulk/template pass issuance, grace-period
extensions, checkout/visit-duration tracking, a traffic analytics report, household member roles,
and AES-256-GCM encryption of visitor phone numbers at rest.

### How we built it
TypeScript + Express, an interface-isolated `RingClient` (real integration point) backed by a
`SimulatedRingClient` for full demoability without Ring hardware or partner credentials, HMAC-SHA256
for both inbound webhook verification and outbound delivery signing, an in-memory pub/sub
`eventBus` feeding the SSE stream.

### Challenges we ran into
No Ring hardware or partner API access in this environment — solved by isolating the entire Ring
integration behind one interface (`src/ringClient.ts`) so swapping in the real Ring API is a
single-file change, documented explicitly in the README. Also: auditing every response path to make
sure a masked phone number is genuinely never exposed once encryption was added — one raw-store
read in the test suite confirms no plaintext PII ever touches disk.

### Accomplishments we're proud of
A full, real access-control lifecycle (issue → arrive → correlate → notify → expire/revoke) with
~50 end-to-end HTTP checks, plus production concerns (webhooks, rate limiting, encryption, quiet
hours) most hackathon demos skip entirely.

### What we learned
Designing the Ring integration seam *first* — before any business logic — made every later round
(recurring passes, bulk issuance, analytics) drop in without touching `ringClient.ts` at all.

### What's next
Swap `SimulatedRingClient` for the real Ring Partner API; replace the demo key derivation for PII
encryption with AWS KMS envelope encryption (flagged explicitly as a gap in `FRICTION_LOG.md`).

**Built with:** typescript, node.js, express, server-sent-events, hmac, webhooks, aes-256-gcm,
docker, amazon-ecs

---

## Project 3 — CourtSide (Fire TV track)

**Tagline:** An AI co-commentator that narrates live sports in plain language and answers "why was
that a foul?" without leaving the video.

**Try it out:** [`firetv-courtside/`](./firetv-courtside)

### Inspiration
Casual viewers tune out of unfamiliar or lower-profile games for lack of context — not lack of
interest. CourtSide sits alongside a live broadcast, narrating plays and answering spoken or typed
questions grounded in the game's actual current state.

### What it does
Tracks live game state (score/clock/period), ingests play-by-play events and immediately produces
plain-language commentary, answers free-form viewer questions grounded in current state and recent
plays, and (round 3–4) adds a live SSE commentary push, outbound alert webhooks for
watched-team/player events, a personalized-per-viewer watchlist, season-long stats aggregation,
auto-generated game recaps, and multi-sport support.

### How we built it
TypeScript + Express, a `CommentaryProvider` interface (the seam a real Bedrock call would sit
behind) backed by a deterministic `TemplateCommentaryProvider` so the whole pipeline is testable
headlessly without a Fire TV device or a computer-vision feed.

### Challenges we ran into
This environment can't run a Fire OS/Vega app or a physical Fire TV — so the submission is scoped
honestly to the backend commentary service a real overlay app would call, with the exact shape of
that integration (`GET /games/:id/commentary` polling, `POST /games/:id/ask` for both D-pad and
voice input) spelled out in the README rather than glossed over.

### Accomplishments we're proud of
51/51 automated checks passing across four feature rounds, including a resumable SSE stream and
signed outbound webhooks — genuinely production-shaped, not a scripted demo.

### What we learned
Separating "what's testable headlessly" from "what needs the real device" up front kept the scope
honest and let every round ship fully verified instead of half-stubbed.

### What's next
A real Vega/Fire OS overlay app; a computer-vision or official play-by-play data feed wired into
`POST /games/:id/events`; swap `TemplateCommentaryProvider` for a real Bedrock-backed provider.

**Built with:** typescript, node.js, express, server-sent-events, webhooks, docker, amazon-ecs

---

## Project 4 — StudyLoop (Bee track)

**Tagline:** Turns an ambient study session into spaced-repetition flashcards automatically — no
manual note-taking.

**Try it out:** [`bee-studyloop/`](./bee-studyloop)

### Inspiration
Students lose track of what they actually covered in a study session, and turning ambient
conversation into structured review material is friction people skip. StudyLoop automates that
conversion end to end.

### What it does
Ingests a session transcript, generates a summary plus flashcards (Q&A pairing, definition
extraction, cloze-deletion fallback), schedules review via a real SM-2 spaced-repetition algorithm,
and (round 2–4) adds quiz mode, shared decks, reminders, adaptive difficulty bias, study streaks
with permanent badges, a cross-deck daily review-session planner, TSV import/export round-tripping,
and on-demand card regeneration.

### How we built it
TypeScript + Express, transcript ingestion isolated behind one `normalizeTranscript` function —
documented as the exact seam where Bee's transcript-retrieval MCP tool would plug in, since it
already returns the same `{speaker, text, timestampMs}` shape this repo defines independently.

### Challenges we ran into
No physical Bee device or Apple Watch in this environment. Rather than fake a device integration,
we designed the ingestion contract to match Bee's actual documented output shape, so the "todo"
for a real integration is a single sync job, not a rewrite.

### Accomplishments we're proud of
68/68 checks passing across four rounds, including a full spaced-repetition scheduler implemented
as pure, independently-testable functions.

### What we learned
An accurate, real spaced-repetition algorithm (SM-2) is not meaningfully harder to implement
correctly than a fake one — so there was no reason to stub it.

### What's next
Wire a real Bee MCP `get_transcript` call into `normalizeTranscript`'s existing array branch;
swap `TemplateFlashcardGenerator` for an LLM-backed generator behind the same interface.

**Built with:** typescript, node.js, express, sm-2-algorithm, docker, amazon-ecs

---

## Project 5 — Model Router (AWS Builder mini-challenge)

**Tagline:** A SageMaker-sidecar-in-front-of-Bedrock routing pattern: cheap and fast for the common
case, escalate to a full foundation model only when confidence is low.

**Try it out:** [`aws-builder-model-router/`](./aws-builder-model-router)

### Inspiration
Off-the-shelf foundation models are often overkill in cost and latency for narrow, well-defined
classification tasks. This is a reusable pattern, demoed via urgency triage for
household-automation-style messages (urgent / routine / informational).

### What it does
Runs a deterministic, explainable sidecar classifier first; if its confidence clears a threshold
(default 0.7), returns immediately at sidecar cost/latency; otherwise escalates to a
foundation-model-shaped provider. Rounds 2–4 add response caching, a circuit breaker with fallback,
shadow evaluation, an adaptive confidence threshold, streaming responses, rate limiting, a
three-tier cascade, cost budgets (global and per-caller), canary/A-B sidecar routing, outbound
alert webhooks, and Prometheus-format metrics export.

### How we built it
TypeScript + Express, both the sidecar and the foundation model behind interfaces shaped exactly
like the real SageMaker/Bedrock SDKs, backed by mock providers — documented so the swap to real AWS
services touches only two files.

### Challenges we ran into
No AWS credentials available in this environment, so proving the *pattern* (not the API call) is
correct meant building an honest cost/latency model for each path and verifying routing decisions
and budget/circuit-breaker behavior deterministically in tests, rather than trusting a live call.

### Accomplishments we're proud of
78/78 checks passing through four rounds of genuinely production-shaped concerns — canary rollout,
per-caller budgets, Prometheus export — on top of the core routing pattern.

### What we learned
A routing decision's correctness (confidence-based escalation, budget enforcement, circuit-breaker
tripping) is fully testable without ever calling a real model, as long as the provider interface
is honest about what a real call would cost and how long it would take.

### What's next
Swap `MockSidecarClassifier`/`MockBedrockProvider` for real SageMaker endpoint + Bedrock
`InvokeModel` calls behind the same interfaces; persist metrics to CloudWatch instead of the local
JSON file.

**Built with:** typescript, node.js, express, aws, sagemaker, bedrock, prometheus, docker,
amazon-ecs

---

## Project 6 — friction-log-toolkit (Open Source mini-challenge)

**Tagline:** A CLI that makes capturing a hackathon friction log as cheap as one terminal command,
in the moment it happens — not reconstructed from memory an hour before the deadline.

**Try it out:** [`friction-log-toolkit/`](./friction-log-toolkit)

### Inspiration
This hackathon's own rules reward a well-written friction log with up to a 10% judging bonus — but
in practice, friction logs get written from memory right before submission, after the specific
error messages and dead-end docs pages are already forgotten. This tool exists to fix that
process gap for every team, not just this one.

### What it does
`friction-log init` / `add "..." --tag friction` / `list` / `export` turns captured points into a
structured Markdown report in the exact "what worked / friction / feature requests" shape used by
every other project in this repo. Rounds 2–4 add stats, config, git-aware auto-tagging, multi-format
export, entry merge/edit/remove, full-text search, a local dashboard server, a `watch` mode REPL,
push/pull sync between two instances, reusable entry templates, an ASCII stats chart, and
keyword-based auto-tag suggestions.

### How we built it
TypeScript CLI (`node:http` for the dashboard — no framework dependency), a portable TSV/JSON
export format for interop with the Bee track's flashcard import.

### Challenges we ran into
A genuine bug surfaced while testing `sync`: driving the test via a blocking `execFileSync` against
a fake remote server hosted in the *same* test process deadlocks, since the blocking call freezes
the event loop the remote handler itself needs — fixed with a `spawn`-based async test helper, and
documented in `FRICTION_LOG.md` as a real lesson for anyone testing loopback HTTP calls this way.

### Accomplishments we're proud of
137/137 checks across four rounds, plus genuine dogfooding — this tool's own `FRICTION_LOG.md`
entries were captured with itself while building it.

### What we learned
The most valuable open-source contribution here isn't a huge feature — it's removing the specific
five seconds of friction (context-switching to write something down) that causes documentation to
never get written at all.

### What's next
Publish to npm; add a GitHub Action that opens a PR comment summarizing captured friction points
automatically at PR time.

**Built with:** typescript, node.js, cli, git

---

## Cross-cutting notes for every project (paste into "Product feedback" fields)

- **Tools used:** Node.js/TypeScript throughout; `@modelcontextprotocol/sdk` for HomeOps; Express
  for every HTTP service; no external LLM/cloud calls anywhere (all AI- and AWS-shaped seams are
  interfaces backed by deterministic mocks, documented per-project as the exact swap-in point).
- **What worked well:** isolating every hardware/cloud dependency (Ring, Bee, Fire TV, Bedrock,
  SageMaker) behind a single interface let every feature round ship fully tested without ever
  needing real credentials or hardware.
- **What didn't / platform friction:** AWS App Runner closed to new customers on 2026-04-30 mid-way
  through building the deploy tooling — the CloudShell deploy scripts in `deploy/` were rewritten
  to target Amazon ECS Express Mode instead once this was confirmed, and that migration itself is
  documented as a friction-log-worthy platform change.
- **Onboarding:** every project's own `README.md` has copy-pasteable curl examples and a
  `npm install && npm test && npm run build` verification sequence; `deploy/README.md` covers
  taking any of the five backend services live from AWS CloudShell with zero local setup.
- **Full friction logs:** see each project's own `FRICTION_LOG.md` for the complete, dated list of
  friction points, feature requests, and design trade-offs encountered while building it.

## Still needed before you actually submit

- [ ] **Demo video** (< 3 minutes, YouTube/Vimeo) — not something this session can produce; record
      a walkthrough of whichever project(s) you submit.
- [ ] **Decide the track + mini-challenge pairing** per project (see the recommendation at the top).
- [ ] **Merge or link to the specific PRs** you want judged — `main` currently has v1 + one
      "advanced features" round per project merged; rounds 3–5 are open PRs (#9–#20) not yet
      merged. Decide whether to merge more of them in before the Oct 23, 2026 deadline, and link
      the exact commit/branch you're submitting if you leave any unmerged.
