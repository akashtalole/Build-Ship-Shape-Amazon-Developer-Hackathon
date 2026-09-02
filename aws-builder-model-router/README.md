# Model Router — the "SageMaker Sidecar" Pattern

Implementation of the "SageMaker Sidecar" idea (idea 3) from
[`hackathon-ideas/aws-builder.md`](../hackathon-ideas/aws-builder.md), generalized into a reusable pattern rather
than tied to one primary track's feature: off-the-shelf foundation models (Bedrock) are often overkill in cost and
latency for narrow, well-defined tasks. This router keeps a small, purpose-built classifier ("sidecar",
SageMaker-shaped) in front of a full foundation model (Bedrock-shaped) — the sidecar handles the common case fast
and cheap, and the router escalates to the foundation model only when the sidecar's own confidence is too low to
trust.

Built for the **AWS Builder mini-challenge** of the
[Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/) ("meaningfully incorporate
AWS services such as Bedrock, AgentCore, SageMaker, Strands SDK, or Kiro"). No AWS credentials are available in this
environment, so both the sidecar and the foundation model sit behind interfaces shaped exactly like the real AWS
SDKs require, backed by mock implementations — see [Swapping in the real AWS services](#swapping-in-the-real-aws-services)
for exactly what changes to go live.

## The demo task: urgency triage for household messages

To make the pattern concrete instead of abstract, the router classifies short household-automation-style messages
(the kind a HomeOps/Alexa+-style assistant or a Ring/Bee-style notification pipeline needs to triage) into one of
three urgency buckets:

- **`urgent`** — "There's smoke coming from the kitchen!", "the front door alarm won't stop"
- **`routine`** — "reminder: trash day is tomorrow", "the furnace filter needs replacing"
- **`informational`** — "FYI, the package was delivered", "heads up, storms expected tonight"

Most messages a household-automation system sees are one of these three unambiguous cases — a job a small,
explainable, keyword-driven classifier handles perfectly well in single-digit milliseconds. Only the genuinely
ambiguous minority ("can you check on things when you get a chance?") needs a full foundation model's language
understanding to triage correctly. Routing on confidence, rather than always calling the expensive model, is the
whole point of the pattern.

## How it works

1. **`POST /classify`** runs the sidecar (`MockSidecarClassifier`) first, always. It's a deterministic keyword/
   pattern matcher — deliberately simple and explainable, not a disguised LLM call — so its cost and latency
   profile is honestly the cheap/fast one it claims to be.
2. If the sidecar's `confidence` meets the threshold (default **0.7**, overridable per request), its answer is
   returned immediately: **fast path**, no foundation model call.
3. If confidence is below the threshold, the router escalates to the foundation model (`MockBedrockProvider`) for a
   fuller answer: **slow path**, at foundation-model cost and latency.
4. Every request's outcome — which path it took, and the simulated cost/latency of each leg — is returned in the
   response and rolled into cumulative metrics.

### Simulated cost & latency (illustrative, not real AWS pricing)

| Path | Cost / request | Latency |
|---|---|---|
| Sidecar (SageMaker-shaped) | ~$0.0001 | ~45 ms |
| Foundation model (Bedrock-shaped) | ~$0.012 | ~850 ms |

These numbers are made up to be directionally realistic (a small real-time SageMaker endpoint really is roughly two
orders of magnitude cheaper and faster than a hosted foundation model call) — a real deployment would replace them
with numbers pulled from CloudWatch (endpoint invocation latency) and the actual SageMaker/Bedrock pricing pages for
the instance type and model chosen. The point they're used to make is directional and quantifiable: **`GET
/metrics`** compares the router's actual cumulative cost against what the same traffic would have cost if every
request always hit the foundation model directly, which is the concrete argument for why this pattern matters.

## Project layout

```
src/
  types.ts               Shared types: SidecarResult, FoundationResult, RouteResult, MetricsSnapshot
  sidecarClassifier.ts   SidecarClassifier interface + MockSidecarClassifier (keyword-based urgency heuristic)
  foundationModel.ts     FoundationModelProvider interface + MockBedrockProvider (template answer + simulated failures)
  rateLimiter.ts         RateLimiter: in-memory, fixed-window, per-caller quota
  router.ts              ModelRouter: routing decision, cache, circuit breaker, shadow eval, feedback, metrics
  server.ts              Express app factory: POST /classify, POST /classify/stream, POST /feedback, GET /metrics
  index.ts               Entry point: wires up the mocks, creates the app, starts listening
test/
  smoke.test.ts          Unit-style router tests (no HTTP) + end-to-end HTTP tests via fetch(), covering every feature below
```

## Running it

```bash
npm install
npm run build
npm start
# Model router listening on http://localhost:4567
```

Or for local iteration: `npm run dev`

### Try it by hand

```bash
# Fast path: an unambiguous, high-confidence input never touches the foundation model
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" -d '{
  "text": "There is smoke and fire in the kitchen, call 911 emergency!"
}' | python3 -m json.tool
# -> "path": "sidecar", "label": "urgent", "confidence": 0.92, "totalCostUsd": 0.0001, "totalLatencyMs": 45

# Escalation path: a genuinely ambiguous input gets a fuller foundation-model answer
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" -d '{
  "text": "Can you check on things when you get a chance?"
}' | python3 -m json.tool
# -> "path": "foundation", "confidence": 0.3, "foundation": {...}, "totalCostUsd": 0.0121, "totalLatencyMs": 895

# A borderline input's routing changes if you lower the confidence threshold
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" -d '{
  "text": "Just a reminder to take out the trash tonight.",
  "threshold": 0.5
}' | python3 -m json.tool
# -> confidence 0.55 is below the default 0.7 threshold (escalates) but clears a threshold of 0.5 (fast path)

# Cumulative metrics: actual cost vs. an always-foundation-model baseline
curl -s localhost:4567/metrics | python3 -m json.tool
```

See [Advanced features](#advanced-features) below for `curl` examples of the cache, the forced-failure fallback path,
and the streaming endpoint.

## Testing

```bash
npm test
```

`test/smoke.test.ts` covers, in order:

1. **Router unit tests (no HTTP):** a clear high-confidence input takes the sidecar path; a zero-keyword-signal
   input escalates to the foundation model; the *same* borderline-confidence input (`confidence` 0.55) routes to the
   foundation model at the default threshold (0.7) but to the sidecar path at a lowered threshold (0.5); and
   cumulative metrics correctly track path counts plus the actual-cost-vs-always-foundation-cost math.
2. **Response cache (unit):** a repeated identical input within the TTL is served from cache (`cacheHit: true`)
   without re-invoking either model; the escalation path is cached too; cache hits are folded into the cumulative
   savings math; and an entry past its TTL (driven by an injectable clock, no real sleeping) is a fresh miss again.
3. **Circuit breaker / fallback (unit):** an always-failing foundation provider trips the breaker open after
   `circuitBreakerFailureThreshold` consecutive failures; every failure falls back to the sidecar's best-effort
   answer (`fallbackUsed: true`, `path: "fallback"`) rather than failing the request; an open circuit fast-fails
   further escalations without even attempting the call; and after the cooldown elapses, a successful half-open
   trial call closes the circuit again. The `FAILURE_TRIGGER` sentinel string is also exercised as the alternate,
   input-driven way to force a failure.
4. **Shadow evaluation (unit):** a confident sidecar answer with `shadowMode: true` returns immediately (same cost
   and latency as without shadow mode) while a background foundation-model call is kicked off; `flushShadowEvaluations()`
   waits for it deterministically, and both an agreement and a deliberately engineered disagreement are checked
   against `shadowAgreementRate`.
5. **Adaptive threshold suggestion (unit):** with no feedback yet, `GET /metrics`-equivalent `getMetrics()` suggests
   nothing; after several fast-path classifications are reported incorrect via `recordFeedback`, the suggested
   threshold moves upward (more conservative) as expected.
6. **End-to-end HTTP tests:** starts the real Express app via `createApp()` on an ephemeral port (`app.listen(0)`)
   and drives it with real `fetch()` calls — the original validation/routing/metrics checks; a repeated request is
   a cache hit over HTTP; `POST /feedback` accepts a known `requestId` (200) and rejects an unknown one (404);
   `POST /classify/stream` delivers dozens of discrete SSE chunks ending in one `done` event; a simulated
   foundation-model outage returns `200` with `fallbackUsed: true` instead of a server error; and a dedicated
   rate-limiting test drives one caller to exactly their 5-request limit, confirms their 6th request gets `429`,
   and confirms a different `X-Caller-Id` is unaffected.

No external services or AWS credentials are required to run the tests.

## Swapping in the real AWS services

Both interfaces are already shaped like their real AWS SDK counterparts, so going live is a matter of implementing
each interface against the real client rather than restructuring anything that calls them.

**Sidecar → Amazon SageMaker.** Replace `MockSidecarClassifier` with a class implementing `SidecarClassifier` using
[`@aws-sdk/client-sagemaker-runtime`](https://www.npmjs.com/package/@aws-sdk/client-sagemaker-runtime):

```ts
import { SageMakerRuntimeClient, InvokeEndpointCommand } from "@aws-sdk/client-sagemaker-runtime";

export class SageMakerSidecarClassifier implements SidecarClassifier {
  private client = new SageMakerRuntimeClient({ region: process.env.AWS_REGION });

  async classify(input: string): Promise<SidecarResult> {
    const response = await this.client.send(new InvokeEndpointCommand({
      EndpointName: process.env.SAGEMAKER_ENDPOINT_NAME, // e.g. "urgency-classifier-prod"
      ContentType: "application/json",
      Body: new TextEncoder().encode(JSON.stringify({ inputs: input })),
    }));
    const body = JSON.parse(new TextDecoder().decode(response.Body));
    const top = body[0]; // shape depends on the container's inference.py — a typical HF
    return { label: top.label, confidence: top.score }; // text-classification container returns [{label, score}, ...]
  }
}
```

That endpoint would be trained (e.g. a fine-tuned DistilBERT or a linear classifier over TF-IDF features) on
labeled household-message data and deployed as a real-time or serverless SageMaker inference endpoint; a hand-written
rule set fills that role for this demo without needing training data or GPU time.

**Foundation model → Amazon Bedrock.** Replace `MockBedrockProvider` with a class implementing
`FoundationModelProvider` using
[`@aws-sdk/client-bedrock-runtime`](https://www.npmjs.com/package/@aws-sdk/client-bedrock-runtime):

```ts
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

export class BedrockFoundationModelProvider implements FoundationModelProvider {
  private client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

  async invoke(prompt: string): Promise<FoundationResult> {
    const response = await this.client.send(new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-haiku-20241022-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return { text: body.content[0].text, inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens };
  }
}
```

**Auth, both cases:** no API keys in application code. Both clients use the AWS SDK's default credential chain — in
production, an IAM role attached to whatever compute calls this code (Lambda, ECS task, EC2 instance), scoped to
`sagemaker:InvokeEndpoint` on the specific endpoint ARN and `bedrock:InvokeModel` on the specific model ARN. Cost and
latency, once live, would come from CloudWatch metrics and the real per-call `Body`/`usage` fields instead of the
constants in `router.ts`.

**Streaming → `InvokeModelWithResponseStreamCommand`.** `POST /classify/stream` (see
[Advanced features](#advanced-features) below) currently chunks `MockBedrockProvider`'s already-complete text after
the fact, because there's no real streaming provider available in this environment. A live implementation swaps in
`InvokeModelWithResponseStreamCommand` instead of `InvokeModelCommand`, and relays each event from the returned
`response.body` async-iterable (`PartialModelResponse`/`chunk.bytes` events, decoded incrementally) straight to the
caller as it arrives — that also improves real time-to-first-token, not just presentation, since the caller starts
seeing text before the model has finished generating the rest of it.

Everything else — `router.ts`, `server.ts`, the metrics math — is completely unaware it's talking to mocks; it only
depends on the two interfaces in `sidecarClassifier.ts` and `foundationModel.ts`.

## Advanced features

Six production-grade additions on top of the base routing pattern, all genuinely implemented and covered by
`test/smoke.test.ts` (not stubs) — see [Testing](#testing) above for exactly which checks cover which feature.

### 1. Response caching

`ModelRouter` caches each `RouteResult` by a key of `threshold + normalized input` (trimmed, lowercased) for a
configurable TTL (`cacheTtlMs`, default 5 minutes). An identical repeat request within the TTL is served from cache
— **skipping the sidecar and the foundation model entirely** — flagged with `cacheHit: true`. Cache hits are folded
into `GET /metrics`'s cost-savings math: the hypothetical "always-foundation" baseline still charges a cache hit at
full foundation-model cost, while the router's actual cost for that request is $0, so a cache-heavy workload shows a
larger `estimatedSavingsUsd` than routing alone would produce.

```bash
# First call: a real classification
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "There is smoke and fire in the kitchen, call 911 emergency!"}' | python3 -m json.tool
# -> no "cacheHit" field

# Identical call again within the TTL: served from cache, no model invoked
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "There is smoke and fire in the kitchen, call 911 emergency!"}' | python3 -m json.tool
# -> "cacheHit": true
```

### 2. Circuit breaker / fallback chain

The router wraps every foundation-model call with a classic circuit-breaker state machine (`closed` →
`open` → `half-open` → `closed`/`open`): after `circuitBreakerFailureThreshold` (default 3) consecutive failures it
opens for `circuitBreakerCooldownMs` (default 30s), fast-failing further escalations without even attempting the
call, then allows one half-open trial call once the cooldown elapses. Any failure (open circuit or a thrown error
from the provider) falls back to **the sidecar's own best-effort answer**, even below its normal confidence
threshold, rather than failing the request — marked `path: "fallback"`, `fallbackUsed: true`. `GET /metrics` exposes
`fallbackRequests` and the current `circuitState`.

Two deterministic ways to simulate a foundation-model outage for testing (see `src/foundationModel.ts`):
`new MockBedrockProvider({ alwaysFail: true })` / `{ failFirstN: n }` as constructor flags, or embedding the
`FAILURE_TRIGGER` sentinel string anywhere in the input text.

```bash
# The FAILURE_TRIGGER sentinel forces this specific call to fail, deterministically, without touching any config
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "Can you check on things? __FORCE_FOUNDATION_FAILURE__"}' | python3 -m json.tool
# -> "path": "fallback", "fallbackUsed": true, 200 OK (not a 500)
```

### 3. Shadow evaluation mode

Passing `"shadowMode": true` (or setting `defaultShadowMode` on the `ModelRouter` constructor) makes a **confident,
fast-path** request also kick off a foundation-model call in the background, purely to compare its implied label
against the sidecar's — after the fast-path response has already been sent, so it adds zero latency and can never
fail the caller's request. `GET /metrics` exposes `shadowEvaluations`, `shadowAgreements`, and
`shadowAgreementRate` — a genuine ML-ops technique for finding out whether a cheap classifier's confident answers
actually match what the expensive model would have said, without paying the expensive model's latency on the happy
path.

```bash
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "There is smoke and fire in the kitchen, call 911 emergency!", "shadowMode": true}' | python3 -m json.tool
# -> the fast-path "sidecar" response, same latency/cost as without shadowMode

curl -s localhost:4567/metrics | python3 -m json.tool
# -> "shadowEvaluations": 1, "shadowAgreements": 1, "shadowAgreementRate": 1
```

### 4. Adaptive threshold suggestion

`GET /metrics` also reports `suggestedThreshold` and `thresholdSuggestionReason`, computed from a pool of "was the
sidecar's trusted (fast-path) answer actually right?" samples drawn from two sources: shadow-mode agreement (feature
3) and explicit caller feedback via `POST /feedback`, keyed by the `requestId` every `/classify` response already
returns. With too few samples it suggests nothing rather than react to noise; otherwise low observed accuracy at the
current threshold nudges the suggestion up (more conservative), and very high accuracy over enough samples nudges it
down (fewer unnecessary escalations). **This is a deliberately simple, illustrative heuristic** — no confidence
intervals, no bias correction — documented as such in `router.ts`, not real statistical rigor.

```bash
# Report that a past classification (by its requestId) was wrong
curl -s -X POST localhost:4567/feedback -H "Content-Type: application/json" \
  -d '{"requestId": "<a requestId from an earlier /classify response>", "correct": false}'

curl -s localhost:4567/metrics | python3 -m json.tool
# -> e.g. "currentThreshold": 0.7, "suggestedThreshold": 0.75,
#    "thresholdSuggestionReason": "Current threshold 0.70, but observed sidecar accuracy at that
#     threshold is only 33.3% over 3 sample(s) — below the 95% target. Consider raising the
#     threshold to 0.75. (Illustrative heuristic, not real statistical rigor...)"
```

### 5. Simulated streaming foundation-model responses

`POST /classify/stream` runs the same routing decision as `/classify`, but for an escalation-path (foundation-model)
result it relays the answer as a sequence of Server-Sent Events — one `chunk` event per word — instead of one JSON
blob, ending in a single `done` event carrying the full result. See
[Streaming → InvokeModelWithResponseStreamCommand](#swapping-in-the-real-aws-services) above for what a live,
truly-incremental version would change.

```bash
curl -N -s -X POST localhost:4567/classify/stream -H "Content-Type: application/json" \
  -d '{"text": "Can you check on things when you get a chance?"}'
# -> a stream of "event: chunk\ndata: {\"token\":\"...\"}\n\n" events, one per word,
#    ending in "event: done\ndata: {...full RouteResult...}\n\n"
```

### 6. Per-caller rate limiting / quota

`RateLimiter` (`src/rateLimiter.ts`) is a small in-memory, fixed-window limiter keyed by the `X-Caller-Id` request
header (an unset header falls back to a shared `"anonymous"` bucket rather than skipping enforcement). It guards
both `/classify` and `/classify/stream`. Exceeding the window's quota returns `429` with a clear message and
`Retry-After`/`X-RateLimit-*` headers; a different caller id is completely unaffected. The default is a generous 60
requests/minute — any real deployment sharing a metered AWS resource (a SageMaker endpoint, a Bedrock model) across
callers needs *some* quota story, and this is the simplest version of that story that's still genuinely enforcing a
limit.

```bash
# Six rapid requests from the same caller, with the default limit lowered for illustration —
# in this demo's default config (60/min) you'd need 61 requests to see this:
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:4567/classify \
    -H "Content-Type: application/json" -H "X-Caller-Id: demo-caller" \
    -d "{\"text\": \"request $i\"}"
done
# -> 200 200 200 200 200 200  (all succeed under the default 60/min limit — lower it via a custom
#    RateLimiter passed to createApp() to see a 429 sooner, as the smoke test does)
```

## A stackable pattern, not a one-off feature

This mini-challenge is explicitly stackable onto any primary-track submission's own AI feature, and this router is
built as a small, standalone library specifically so it can sit in front of *any* narrow classification or triage
decision another track's feature needs to make — not just this repo's urgency-classification demo. Two concrete
examples already exist elsewhere in this same repository as sibling submissions (on other branches, so they may not
be visible from every checkout of this one):

- **`alexa-homeops-mcp/`** (Alexa+ track) — HomeOps' task/expense/shopping orchestration could use this router to
  triage which household requests need a full LLM-driven planning turn versus which ones a fast heuristic can
  resolve directly (e.g. "add milk to the list" vs. "figure out who should pick up the kids given everyone's
  calendars").
- **`ring-porchpass/`** (Ring track) — PorchPass could use this router in front of any future computer-vision
  scoring of doorbell snapshots (e.g. "is this a package delivery or a person lingering?"), letting a cheap sidecar
  handle the obvious cases and escalating only ambiguous frames to a full vision-capable foundation model.

Swapping in either integration is exactly the `SidecarClassifier`/`FoundationModelProvider` implementation swap
described above — the router, metrics, and HTTP layer need no changes.

## Judging-criteria alignment

- **Tech Implementation:** A working, tested TypeScript library with two AWS-SDK-shaped interfaces, a
  framework-agnostic router with real routing logic (not a stub), an Express API, and a smoke test suite exercising
  both the library directly and the full HTTP surface. Zero TypeScript errors under `strict: true`. Beyond the base
  routing decision, six genuinely-working production-grade features (see [Advanced features](#advanced-features)):
  a TTL response cache, a circuit breaker with a sidecar-fallback chain, background shadow evaluation, a
  feedback-driven adaptive-threshold suggestion, simulated SSE streaming, and per-caller rate limiting — each with
  its own passing test coverage, not stubbed.
- **Design:** The interfaces mirror the real `@aws-sdk/client-sagemaker-runtime` / `@aws-sdk/client-bedrock-runtime`
  request/response shapes closely enough that going live is a class-body swap, not a redesign — the architectural
  seam is the deliverable, not just working code behind it. The advanced features are each standard, named
  production patterns (circuit breaker, shadow deployment, quota management) applied to *this specific* seam rather
  than bolted on generically, and each is honestly scoped: the adaptive-threshold heuristic and the streaming
  endpoint's chunking-after-the-fact are both explicitly documented as illustrative simplifications, not claims of
  statistical rigor or true incremental generation.
- **Potential Impact:** This is a genuinely reusable AWS architecture pattern, not tied to one feature — any track
  with an AI feature that mostly handles predictable cases (which is most of them) can drop this router in front of
  its own model calls and get a concrete, measurable cost/latency win, as `GET /metrics` demonstrates numerically.
- **Quality of Idea:** Directly addresses the AWS Builder mini-challenge's own framing — "off-the-shelf foundation
  models are often overkill for narrow, well-defined tasks" — with a demo task grounded enough (urgency triage) to
  be concretely testable, while staying generalizable enough to be a pattern rather than a single feature.
