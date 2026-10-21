# Devpost Submission Draft: HomeOps

Text to paste into the Devpost form at https://amazonappdev2026.devpost.com/. Everything below describes code that
exists and is tested in [`alexa-homeops-mcp/`](./alexa-homeops-mcp). Items still to do before submitting are
listed at the end.

| Field | Value |
|---|---|
| **Project** | HomeOps |
| **Track** | Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP) |
| **Mini-challenge** | AWS Builder (Claude on Amazon Bedrock, deployed on Amazon ECS Express Mode). Alternative: Open Source, once the repo is public |
| **Repo** | `akashtalole/Build-Ship-Shape-Amazon-Developer-Hackathon`, folder `alexa-homeops-mcp/` |

## Why only HomeOps

The repo also contains projects for Fire TV, Bee, Ring, and both mini-challenges. They aren't submitted because
they don't meet their tracks' hardware requirements yet: CourtSide is a backend with no Fire OS/Vega app, StudyLoop
has no data from a real Bee device, and PorchPass uses its own simulator rather than Ring's. Each project can win at
most one track prize and one mini-challenge prize, so the effort goes into the one entry that fully qualifies.

---

**Tagline:** A self-hosted MCP server that lets Alexa+ run the household (tasks, shopping, budget, meals) in one
conversation instead of one command at a time.

## Inspiration

Alexa+ is built for multi-step, agentic requests, but most skills still handle one isolated command. We wanted
"what's due today, is anything running low, and are we on budget?" to be one turn, which means giving Alexa+ real
tools it can chain, plus the judgment to ask before spending money.

## What it does

HomeOps exposes household tools over MCP that Alexa+ chains together:

- **Morning briefing in one call.** `run_morning_briefing` combines today's tasks, who's next for chores, low stock,
  and budget status, then narrates them. One round trip instead of four matters for voice.
- **Say it however you like.** `capture_note` takes one plain sentence ("we're almost out of coffee", "pick up
  dry cleaning by Friday", "I just spent $120 on groceries") and routes it to the shopping list, a task with a due
  date, or an expense, so nobody has to know which tool does what.
- **Asks before spending.** `reorder_item` uses MCP elicitation, so Alexa+ asks the user to confirm before an order
  goes through. Retries are safe because of an idempotency key.
- **Notices problems on its own.** `get_proactive_alerts` flags one person carrying most of the chores, a budget
  category on pace to go over (before it does), and items that have been low for days without being reordered.
- **Plans meals from what's running low.** `suggest_meal_plan` uses low-stock items, the remaining grocery budget,
  and busy days on the calendar (busy days get quick meals).
- Fair chore rotation, recurring tasks, an allowance ledger for kids, and a weekly digest.

Under the hood: per-household data isolation via bearer tokens, read-only tokens, file-backed persistence,
resumable Streamable HTTP sessions, HMAC-signed alert webhooks, and MCP resources with live update notifications.

## How we built it

- TypeScript, `@modelcontextprotocol/sdk` (negotiates protocol version 2025-11-25), Express for Streamable HTTP.
- **Claude on Amazon Bedrock** for the model-backed tools. HomeOps asks the client's own model first (MCP sampling).
  If the client can't sample, it calls Claude on Bedrock through the Bedrock Mantle client, retries refusals on a
  second model, and times out after 20 seconds with a templated answer as the last resort.
- A **voice tool profile** that shows Alexa+ only the 12 tools a household member would ask for. The admin and
  setup tools stay available in the full profile.
- **Deployed from AWS CloudShell** to Amazon ECS Express Mode with one script: container image in ECR, HTTPS
  endpoint, and a least-privilege IAM task role for Bedrock.
- Every feature tested end to end with a real MCP client over HTTP: 41 checks, including Bedrock requests through
  the real SDK against a fake endpoint (normal, refusal-then-fallback, and error paths).

## Challenges we ran into

- **Hidden dependence on a client capability.** Four features used MCP sampling and quietly fell back to templates
  when the client lacked it. Tests passed, but a client without sampling would never have shown the model-backed
  behavior. Adding Claude on Bedrock as the second path fixed it.
- **Too many tools for a voice agent.** After six feature rounds the server had 25 tools. More choices make an
  agent likelier to pick the wrong one, so we added the voice profile rather than deleting capability.
- **App Runner closed to new customers mid-build.** The deploy scripts were rewritten for Amazon ECS Express Mode.
- Details, including IAM and SDK surprises, are in [`alexa-homeops-mcp/FRICTION_LOG.md`](./alexa-homeops-mcp/FRICTION_LOG.md).

## Accomplishments we're proud of

- Uses MCP features most servers don't touch: elicitation, sampling, resource templates with completion, progress
  and logging notifications, structured output, resumable transport.
- Degrades instead of failing: no sampling → Bedrock; Bedrock refusal → second model; Bedrock down → templated
  answer; no elicitation support → preview-then-confirm.
- 41 end-to-end checks, all passing, plus typecheck and build before every commit.

## What we learned

A good fallback can hide that the main path never runs in the target environment. Testing against the real client's
capabilities matters as much as testing the code.

## What's next

DynamoDB instead of JSON files for multi-instance durability, push notifications for proactive alerts, and grocery
reordering against a real retailer API.

**Built with:** typescript, node.js, express, model-context-protocol, alexa, amazon-bedrock, claude, amazon-ecs,
amazon-ecr, aws-iam, docker

---

## Product feedback (Devpost "feedback" fields)

- **What worked:** The MCP SDK's elicitation and sampling made it possible to keep spending confirmations and LLM
  calls protocol-native. ECS Express Mode gave a public HTTPS endpoint from one CLI call.
- **What didn't:** It was hard to find which IAM action Bedrock's Messages endpoint needs (`bedrock-mantle:*`, not
  the `bedrock:InvokeModel` most examples show). App Runner closing to new customers forced a mid-build migration.
- **Feature requests:** Document which MCP client capabilities (sampling, elicitation) Alexa+ supports; show the
  required IAM action next to each Bedrock code sample.
- **Friction log:** [`alexa-homeops-mcp/FRICTION_LOG.md`](./alexa-homeops-mcp/FRICTION_LOG.md) (23 entries).

## Still needed before submitting

- [ ] **Make the repo public** (Settings → General → Change visibility). Required for every track and for the
      Open Source mini-challenge.
- [ ] **Deploy and connect to the Alexa+ web simulator:** `./deploy/deploy.sh alexa-homeops-mcp` from CloudShell,
      then register `https://<service-url>/mcp`. Record anything that breaks in the friction log.
- [ ] **Confirm Bedrock model access** for `anthropic.claude-opus-5-5` in the deploy region.
- [ ] **Record the four Alexa+ simulator clips** and run `./demo/assemble.sh`. Narration, cards and assembly are ready;
      see [`demo/README.md`](./demo/README.md) for exactly what to say in each clip.
- [ ] **Pick the mini-challenge:** AWS Builder (Bedrock + ECS) or Open Source (public repo). Only one can be won.
- [ ] Submit before **Oct 23, 2026, 12:00 PM PDT**.
