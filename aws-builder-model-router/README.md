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
  types.ts               Shared types: SidecarResult, FoundationResult, RouteResult, MetricsSnapshot, CanaryStatus, CallerBudgetSnapshot,
                         EnsembleStatus, DriftStatus, CostRecommendation, AuditRecord, AuditExportResult (round 5)
  sidecarClassifier.ts   SidecarClassifier interface + MockSidecarClassifier (keyword-based urgency heuristic, configurable for canary/A-B
                         routing and multi-sidecar ensemble voting)
  foundationModel.ts     FoundationModelProvider interface + MockBedrockProvider (template answer + simulated failures)
  reviewerModel.ts       MockReviewerProvider: the three-tier cascade's cheaper/faster mid-tier "reviewer" model
  budgetTracker.ts       BudgetTracker: fixed-window dollar-spend cap for cost-budget enforcement (one instance per caller as of round 4)
  alertWebhooks.ts       AlertWebhookDispatcher: HMAC-SHA256-signed outbound webhook delivery for budget/circuit-breaker/drift alerts
  prometheusFormat.ts    renderPrometheusMetrics: renders GET /metrics's JSON as Prometheus exposition-format text
  metricsPersistence.ts  loadMetricsState/saveMetricsState: demo-grade JSON file persistence for cumulative metrics
  auditTrail.ts          appendAuditRecord/loadAuditRecords: demo-grade JSON-Lines file persistence for the per-request audit trail (round 5)
  rateLimiter.ts         RateLimiter: in-memory, fixed-window, per-caller quota
  router.ts              ModelRouter: routing decision (3-tier cascade), cache, circuit breaker, shadow eval, feedback, per-caller budgets,
                         canary routing, alerts, persistence, drift detection, ensemble voting, cost recommender, audit trail, metrics
  server.ts              Express app factory: POST /classify(/stream), POST /feedback, POST+GET+DELETE /budget(/all),
                         POST+GET+DELETE /router/canary, POST+GET+DELETE /router/ensemble, POST+GET+DELETE /alerts/webhook,
                         POST+GET+DELETE /drift/config, GET /drift/status, GET /recommendations/cost, GET /audit/export,
                         GET /metrics(/prometheus)
  index.ts               Entry point: wires up the mocks (incl. the reviewer), creates the app, starts listening, persists metrics + audit
                         trail on shutdown
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
7. **Classification explainability (unit):** a confident classification's `explanation` and `sidecar.matchedKeywords`
   both cite the real keyword(s) that drove it (e.g. `"fire"`); a single-keyword borderline match reports exactly
   that one keyword; and a zero-signal input is honestly explained as a low-confidence default guess rather than a
   fabricated match.
8. **Three-tier cascade (unit):** a clearly-confident input still resolves at the sidecar tier without ever
   consulting the reviewer; a borderline-confidence input (engineered to land exactly at the reviewer-band boundary)
   resolves at the mid tier when the reviewer model's independent guess confirms the sidecar's label; a different
   borderline input where the reviewer's own guess *disagrees* cascades on to the full foundation model, billing all
   three tiers; a clearly-low-confidence input still escalates straight to the top tier, skipping the reviewer
   entirely; `GET /metrics`'s `reviewerPathRequests`/`reviewerPathRate` reflect the mid-tier resolutions; omitting the
   `reviewer` option collapses the router back to the original two-tier behavior; and a reviewer call that fails
   outright fails open to the top tier rather than silently trusting the sidecar.
9. **Cost-budget enforcement (unit + HTTP):** with no budget configured, escalation is never throttled; configuring a
   budget that covers exactly one escalation lets that first call through, then throttles the next one to the
   sidecar's best-effort answer (`path: "sidecar"`, `budgetExceeded: true`) without calling the foundation model;
   `GET /budget`'s `exceeded`/`spendUsd` reflect this; `budgetThrottledRequests` in `GET /metrics` is tracked
   separately from genuine `sidecarPathRequests`; clearing the budget lifts the throttle immediately; and a dedicated
   HTTP test drives the same story through real `POST`/`GET /budget` and `POST /classify` calls, including a 400 on
   an invalid budget body.
10. **Persistent metrics (unit):** `persistMetricsNow()` writes cumulative path counts, cache stats, and budget
    config/spend to a JSON file; a **freshly-constructed** `ModelRouter` pointed at that same file (simulating a
    process restart) reloads those totals instead of resetting to zero, and continues accumulating correctly on top
    of them; a `persistEveryNRequests`-configured router auto-saves after that many calls with no explicit save; and
    pointing at a metrics file that doesn't exist yet starts fresh rather than throwing.
11. **Per-caller cost budgets (unit + HTTP):** two callers with different `setBudget(limit, periodMs, callerId)`
    configurations are throttled completely independently — one caller's exhausted budget never affects the other's;
    a caller who never configured their own budget falls back to the shared default (and continues to, even after a
    different caller's override is cleared); `GET /metrics`'s `callerBudgets` lists exactly the callers with an
    explicit override; and a dedicated HTTP test drives the same story through `POST`/`GET /budget` scoped by
    `X-Caller-Id`, plus `GET /budget/all` for the admin/dashboard view of every caller at once.
12. **Canary/A-B sidecar routing (unit + HTTP):** a candidate sidecar configured with a keyword the primary doesn't
    recognize disagrees with the primary on every evaluated input containing it (a deterministic disagreement signal,
    independent of the random traffic-split draw); registering it at a given percentage and running hundreds of
    requests shows the candidate actually serving roughly that share of traffic (a probabilistic check with a
    generous tolerance band, not an exact count); clearing the canary stops routing to it without erasing the
    cumulative comparison counters; and a dedicated HTTP test drives `POST`/`GET`/`DELETE /router/canary`, including
    a 400 on an out-of-range `percentage`.
13. **Outbound alert webhooks (HTTP + unit):** a local Node `http` listener stands in for an operator's own webhook
    receiver; registering it via `POST /alerts/webhook` hands back a signing secret; exceeding a configured budget
    fires a `budget_exceeded` delivery whose `X-ModelRouter-Signature` header is independently recomputed and checked
    against the raw body with that exact secret; tripping the circuit breaker (an always-failing foundation provider)
    fires a `circuit_open` delivery the same way; and a further failure while the circuit is already open confirms no
    duplicate `circuit_open` alert fires (transition-only, not one-per-failure).
14. **Prometheus-format metrics export (HTTP):** `GET /metrics/prometheus` returns `200 text/plain`; every metric
    name that appears has both a `# HELP` and a `# TYPE` comment; labeled series (per-circuit-breaker-state, per-caller
    budgets) render with the expected `{label="value"}` syntax; the round-4 canary and alert-webhook metric names are
    all present; and `GET /metrics`'s original JSON shape is confirmed unchanged by the new endpoint's existence.
15. **Sidecar drift detection (unit + HTTP):** with detection unconfigured, `getDriftStatus()` reports `enabled: false`
    and a rolling agreement rate of 1 (no evidence of drift); an injectable `random()` proves sampling only fires a
    background comparison on the configured fraction of draws, independent of the per-request `shadowMode` flag; a
    deliberately-disagreeing fixture fed repeatedly activates the alert only once the rolling window is genuinely
    full (not on a handful of early samples), and a subsequent run of agreements clears it again; disabling detection
    stops new sampling without erasing cumulative stats; a dedicated webhook test confirms a sustained disagreement
    fires a correctly HMAC-signed `drift_alert` delivery through the existing alert mechanism; and an HTTP test drives
    `POST`/`GET`/`DELETE /drift/config(/status)`, including a 400 on an out-of-range `sampleRate`, and confirms real
    `/classify` traffic can activate the alert end-to-end.
16. **Multi-sidecar ensemble voting (unit + HTTP):** with no ensemble configured, `getEnsembleStatus()` reports
    `enabled: false` and `memberCount: 1` (the primary alone); a scenario where the primary alone is only borderline
    but a second, independently-configured member corroborates its label more strongly shows the weighted-average
    combined confidence clearing the threshold and resolving at the sidecar tier without ever escalating (and billing
    2 real sidecar-endpoint invocations, not a flat single fee); a genuine disagreement between members (a marker
    keyword only one member recognizes) keeps the combined confidence low enough that the router still correctly
    escalates rather than picking a winner arbitrarily; clearing the ensemble reverts to the primary alone without
    erasing cumulative vote-comparison metrics; and an HTTP test drives `POST`/`GET`/`DELETE /router/ensemble`,
    including a 400 on an empty `members` array.
17. **Cost-optimization recommender (unit + HTTP):** with too few escalations observed, the recommendation is honestly
    `insufficient_data`; a cluster of genuinely low-confidence (below-reviewer-band) escalations correctly yields
    `no_change` rather than an unsafe shortcut; reviewer-band escalations with no reviewer configured yield a concrete
    `enable_reviewer_tier` recommendation with real projected dollar savings; the same band's escalations when a
    reviewer *is* configured but still disagrees yield a `lower_threshold` recommendation instead, with an honestly
    "unknown" accuracy risk before any feedback/shadow data exists and a real, non-zero risk estimate once some does
    (reusing the exact same pooled accuracy signal the adaptive-threshold suggestion already computes); and an HTTP
    test confirms `GET /recommendations/cost` computes all of this from real traffic driven through `POST /classify`,
    not a canned message.
18. **Per-request audit trail export (unit + HTTP):** with no `auditLogPath` configured, `exportAuditTrail()` still
    returns real records from the bounded in-memory buffer; a configured `auditLogPath` persists a compact
    JSON-Lines record — including cache hits, which are still real routing decisions — for every request, verified by
    reading the file directly; `sinceMs` filtering excludes earlier records by their recorded timestamp (driven
    through an injectable clock for determinism) while `limit` caps the export to the most recent N; aggregate
    `totalCostUsd`/`totalLatencyMs` and per-path counts are checked against the underlying records; and an HTTP test
    drives `GET /audit/export` (including a 400 on an unparseable `since` and a working `?limit=`) against real
    traffic sent with an `X-Caller-Id`, confirming it appears in the exported records.

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

**Mid tier (reviewer) → a second, smaller Bedrock model.** `MockReviewerProvider` (`reviewerModel.ts`) is already
shaped exactly like `FoundationModelProvider` — the same interface `MockBedrockProvider` implements — so going live
is the *same* class-body swap shown above for the top tier, just constructed a second time with a smaller/cheaper
`modelId` (e.g. `anthropic.claude-3-5-haiku-...` for the reviewer vs. a larger Sonnet/Opus-class model for the top
tier). No other code changes: `ModelRouter` only knows it received "a `FoundationModelProvider`," not which size of
model backs it.

Everything else — `router.ts`, `server.ts`, the metrics math — is completely unaware it's talking to mocks; it only
depends on the interfaces in `sidecarClassifier.ts` and `foundationModel.ts` (the latter shared by both the reviewer
and the top-tier foundation model).

## Advanced features

Eighteen production-grade additions on top of the base routing pattern, all genuinely implemented and covered by
`test/smoke.test.ts` (not stubs) — see [Testing](#testing) above for exactly which checks cover which feature. The
first fourteen are rounds 1–4 (production/MLOps hardening: caching, circuit breaking, budgeting, canary, etc.);
**rounds 15–18 below are round 5**, and are a different kind of feature — not more infrastructure hardening, but
genuinely new capability an AWS ML platform team would want: automated drift monitoring, multi-model consensus,
self-analyzing cost optimization, and compliance-grade auditability.

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

### 7. Three-tier cascade: a mid-tier "reviewer" model

Between the sidecar and the full foundation model sits an optional third tier: a cheaper/faster **reviewer** model
(`MockReviewerProvider`, `src/reviewerModel.ts`) — same `FoundationModelProvider` shape as the top-tier
`MockBedrockProvider`, but modeling a smaller model (lower simulated cost `REVIEWER_COST_USD` **$0.002** and latency
`REVIEWER_LATENCY_MS` **250ms**, vs. the top tier's $0.012/850ms) with its own independent keyword-hint heuristic.

The cascade is driven by two thresholds, both configurable:

| Sidecar confidence | Tier |
|---|---|
| `>= threshold` (default 0.7) | **Sidecar** — trusted directly, no escalation |
| `>= reviewerConfidenceThreshold` (default **0.6**) and `< threshold` | **Reviewer** — the cheaper model is consulted |
| `< reviewerConfidenceThreshold` | **Foundation** — straight to the full model, reviewer skipped |

In the reviewer band, if the reviewer's own independent guess **agrees** with the sidecar's label, that resolves the
request at the mid tier (`path: "reviewer"`) — cheaper and faster than the top tier, without giving up a second
opinion. If the reviewer **disagrees** (or its call fails outright), the router escalates once more to the full
foundation model, billing all three tiers' cost/latency. Why skip the reviewer entirely below
`reviewerConfidenceThreshold` rather than always trying it first? See `DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD`'s doc
comment in `router.ts` — a genuinely near-zero-signal input is unlikely to benefit from a *second*, similarly-sized
model's opinion, so the router pays for the full model's stronger language understanding directly instead of paying
for both. `reviewer` is an optional `ModelRouterOptions` field — omitting it collapses the router back to the
original two-tier behavior with no other changes.

```bash
# A borderline-confidence input that lands in the reviewer band and the reviewer confirms
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "reminder: the grocery order today, though there is a leaking pipe outside too."}' | python3 -m json.tool
# -> "path": "reviewer", "confidence": 0.6, "reviewer": {...}, no "foundation" field

curl -s localhost:4567/metrics | python3 -m json.tool
# -> "reviewerPathRequests": 1, "reviewerPathRate": ...
```

### 8. Cost-budget enforcement

`POST /budget { "limit": <dollars>, "periodMs": <milliseconds> }` configures a **fixed-window dollar cap** on the
router's paid-tier spend (the reviewer and full foundation model — the sidecar's own tiny, always-incurred cost isn't
budgeted). Once cumulative spend for the current period reaches the limit, the router auto-throttles: further
escalations — even a clearly low-confidence input that would normally reach the top tier — are answered with the
sidecar's best-effort classification instead, flagged `budgetExceeded: true` so a caller can tell it apart from a
normal fast-path hit (which never sets that flag). `GET /budget` reports current spend, the limit, and time remaining
in the period. See `budgetTracker.ts`'s doc comment for exactly why this is a fixed window (not rolling) and a dollar
cap (not a request-count cap) — both deliberate, documented simplifications for a demo, not oversights.

```bash
# Configure a small budget — 1 cent per hour
curl -s -X POST localhost:4567/budget -H "Content-Type: application/json" \
  -d '{"limit": 0.01, "periodMs": 3600000}' | python3 -m json.tool
# -> "enabled": true, "limitUsd": 0.01, "spendUsd": 0, "exceeded": false

# ...after enough escalations exhaust that budget:
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "Can you check on things when you get a chance?"}' | python3 -m json.tool
# -> "path": "sidecar", "budgetExceeded": true — the foundation model was never called

curl -s localhost:4567/budget | python3 -m json.tool
# -> "exceeded": true, "remainingUsd": 0, "msRemainingInPeriod": ...
```

### 9. Classification explainability

Every `SidecarResult` now carries `matchedKeywords`: the specific keyword(s)/pattern(s) that drove the classification
— not just the label and a confidence number. `RouteResult.explanation` weaves that signal into a human-readable
sentence (`Sidecar classified this as "urgent" ... (matched signal(s): "fire", "smoke") ...`) at every tier, including
the reviewer and fallback paths, so a caller (or a judge reading a response body) can see *why*, not just *what*. A
zero-signal input is explained honestly as a low-confidence default guess rather than a fabricated match. This is
explicitly the keyword-heuristic sidecar's own explainability story — see `SidecarResult`'s doc comment in `types.ts`
for why a trained-model endpoint would need a different mechanism (e.g. attention weights or SHAP values) and might
not have `matchedKeywords` at all.

```bash
curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "There is smoke and fire in the kitchen, call 911 emergency!"}' | python3 -m json.tool
# -> "sidecar": {"label": "urgent", "confidence": 0.92, "matchedKeywords": ["fire", "smoke", "emergency", "call 911"], ...},
#    "explanation": "Sidecar classified this as \"urgent\" with confidence 0.92 (matched signal(s): \"fire\", \"smoke\",
#     \"emergency\", \"call 911\"), meeting the 0.70 threshold — no escalation needed."
```

### 10. Persistent metrics

`ModelRouter` can be configured with a `metricsPersistPath` (index.ts points it at `metrics-state.json` in the
package root by default). Cumulative path counts, cache stats, circuit-breaker state, shadow-eval totals, and budget
config/spend are written to that JSON file every `persistEveryNRequests` calls (default 20) and on graceful shutdown
(`SIGINT`/`SIGTERM` in `index.ts` call `router.persistMetricsNow()`), and reloaded automatically the next time a
`ModelRouter` is constructed pointed at the same path — so restarting the demo server doesn't reset the cost-savings
story back to zero. This is **demo-grade persistence**, explicitly not a production datastore: plain synchronous
`fs.writeFileSync` with no atomic rename-on-write and no file locking (fine for one process; two processes sharing a
path would clobber each other) — see `metricsPersistence.ts`'s doc comment for the full honest list, same framing as
this repo's other simple file-based persistence.

```bash
npm start
# ...classify a few messages, building up real metrics...
curl -s localhost:4567/metrics | python3 -m json.tool   # note totalRequests, actualCostUsd, etc.

# Ctrl-C the server (a graceful SIGINT), then start it again:
npm start
curl -s localhost:4567/metrics | python3 -m json.tool
# -> the same cumulative totals as before the restart, not reset to zero
```

### 11. Per-caller cost budgets

Round 3's `POST`/`GET /budget` was global — one shared budget for every caller. Round 4 scopes it per caller, reusing
the exact identification mechanism the per-caller rate limiter already uses: the `X-Caller-Id` header. Send it on a
`/budget` call and you're configuring/reading **that caller's own independent budget**, tracked and enforced
completely separately from every other caller's; omit it (as every pre-round-4 call shape still does) and you're
configuring/reading the **shared default** instead — which is also what any caller *without* their own override falls
back to, rather than being silently unbudgeted. That fallback is the "sensible default" for callers who never set
their own: whatever the operator has configured as the shared default (including "nothing yet," preserving the exact
pre-round-4 behavior when nobody has configured any budget at all).

```bash
# Give one specific caller ("mobile-app") their own tight budget
curl -s -X POST localhost:4567/budget -H "Content-Type: application/json" -H "X-Caller-Id: mobile-app" \
  -d '{"limit": 0.01, "periodMs": 3600000}' | python3 -m json.tool
# -> "enabled": true, "limitUsd": 0.01 — this budget belongs to "mobile-app" alone

# A different caller, with no override of their own, is governed by the shared default instead
curl -s localhost:4567/budget -H "X-Caller-Id: some-other-caller" | python3 -m json.tool
# -> whatever the shared default currently is (unconfigured -> "enabled": false, unaffected by mobile-app's budget)

# See every caller with an explicit override at a glance, alongside the shared default
curl -s localhost:4567/budget/all | python3 -m json.tool
```

### 12. Canary / A-B sidecar routing

`POST /router/canary { "percentage": <0..1>, "config": {...} }` registers a second "candidate" `MockSidecarClassifier`
alongside the primary one — tuned via `config` (`extraKeywords` and/or `confidenceScale`, since both sidecars here are
the same keyword-heuristic class; a real deployment would point this at a genuinely different trained-model
endpoint). From then on, **every** request evaluates both classifiers on the same input — mirroring the spirit of the
advanced round's shadow evaluation, but comparing two *sidecar* configurations against each other instead of
sidecar-vs-foundation — and `percentage` of the time, the candidate's answer (not the primary's) is the one that
actually continues through the rest of the routing decision. `GET /metrics` (and the dedicated `GET /router/canary`)
report how often the two disagreed and what share of traffic the candidate actually ended up serving, so you can
compare the *observed* traffic split against the *configured* one and watch for a candidate that disagrees with the
primary more than expected before ever promoting it to be the new primary.

```bash
# Route 30% of traffic to a candidate that's more conservative (scaled-down confidence) than the primary
curl -s -X POST localhost:4567/router/canary -H "Content-Type: application/json" \
  -d '{"percentage": 0.3, "config": {"confidenceScale": 0.8}}' | python3 -m json.tool
# -> "enabled": true, "percentage": 0.3, "evaluations": 0, "disagreements": 0

# ...classify a bunch of messages...
curl -s localhost:4567/router/canary | python3 -m json.tool
# -> "evaluations": 47, "disagreements": 5, "disagreementRate": 0.106, "servedRequests": 15 (~30% of 47)

# Done comparing — stop routing to the candidate (comparison counters are preserved, not reset)
curl -s -X DELETE localhost:4567/router/canary | python3 -m json.tool
```

### 13. Outbound alert webhooks

Everything else an operator can observe about this router is **pull** — `GET /metrics`, `GET /budget`, `GET
/router/canary` — something you have to remember to poll. `POST /alerts/webhook { "url": "..." }` adds a **push**
surface: register a callback URL once (getting back a signing secret, shown exactly once) and the router POSTs to it
whenever a (global or per-caller) cost budget is exceeded or the foundation-model circuit breaker trips open, signed
`HMAC-SHA256` over the raw JSON body — the same scheme `ring-porchpass`'s `webhookAuth.ts`/`outboundWebhooks.ts` use,
so your receiver recomputes the signature with the secret and compares it (constant-time) before trusting the
payload. Delivery is fire-and-forget with retries (up to 3 attempts, exponential backoff) so a slow or down receiver
never adds latency to the classification request that triggered the alert.

```bash
# Register your own callback (e.g. a webhook.site URL for testing, or your own receiver)
curl -s -X POST localhost:4567/alerts/webhook -H "Content-Type: application/json" \
  -d '{"url": "https://your-receiver.example.com/hook"}' | python3 -m json.tool
# -> { "url": "...", "secret": "a1b2c3...", "createdAt": "..." } — save that secret, it's shown only once

# ...configure a tight budget and exhaust it, or trip the circuit breaker...
# Your receiver gets a POST with headers:
#   X-ModelRouter-Event: budget_exceeded   (or: circuit_open)
#   X-ModelRouter-Signature: <hex hmac-sha256 of the raw JSON body, using your secret>
# and a body like: {"type":"budget_exceeded","occurredAt":"...","detail":{"callerId":"...","limitUsd":0.01,"spendUsd":0.012,"periodMs":3600000}}

curl -s localhost:4567/alerts/webhook | python3 -m json.tool
# -> delivery history: "deliveries", "failures", "lastSuccessAt", "consecutiveFailures", ...
```

### 14. Prometheus-format metrics export

`GET /metrics` (JSON) is unchanged. `GET /metrics/prometheus` renders the **same underlying numbers** — every field
in `MetricsSnapshot`, plus the shared/per-caller budget statuses and the alert-webhook delivery status that live
outside it — as plain-text [Prometheus exposition format](https://github.com/prometheus/docs/blob/main/content/docs/instrumenting/exposition_formats.md):
`# HELP`/`# TYPE` comments followed by `metric_name{labels} value` lines, computed fresh on every scrape so there's
no separate metrics-tracking code path to keep in sync with `GET /metrics`. Point a real Prometheus server's scrape
config at this endpoint (or run `promtool check metrics < output` against a saved response) to verify it independently.

```bash
curl -s localhost:4567/metrics/prometheus
# -> # HELP model_router_requests_total Total classification requests handled (cache hits included).
#    # TYPE model_router_requests_total counter
#    model_router_requests_total 47
#    ...
#    # TYPE model_router_circuit_state gauge
#    model_router_circuit_state{state="closed"} 1
#    model_router_circuit_state{state="open"} 0
#    model_router_circuit_state{state="half-open"} 0
#    ...
#    model_router_canary_enabled 1
#    model_router_canary_percentage 0.3
#    ...
```

### 15. Sidecar drift detection

Production model drift monitoring, without paying full foundation-model cost on every request just to watch for it.
`POST /drift/config { "sampleRate": <0..1>, "windowSize": <n>, "alertThreshold": <0..1> }` configures a **random
sample** of otherwise-confident sidecar-path traffic (the same trigger point as shadow evaluation) to *also* be routed
through the foundation model, purely to compare labels. Unlike shadow evaluation — opt-in per request via
`shadowMode: true`, reported as an **all-time** agreement rate with no alerting — drift detection is router-level and
always-on once configured, tracked over a **rolling window** of the most recent `windowSize` comparisons, and fires an
outbound `drift_alert` webhook (reusing the exact same HMAC-signed delivery mechanism as `budget_exceeded`/
`circuit_open`) the moment the rolling agreement rate drops below `alertThreshold` — once per transition into that
state, not once per request, exactly like the circuit breaker's own alerting. `GET /drift/status` reports the current
configuration plus both the rolling and all-time stats.

```bash
# Sample 10% of confident traffic, alert if agreement over the last 20 comparisons drops below 80%
curl -s -X POST localhost:4567/drift/config -H "Content-Type: application/json" \
  -d '{"sampleRate": 0.1, "windowSize": 20, "alertThreshold": 0.8}' | python3 -m json.tool
# -> "enabled": true, "sampleRate": 0.1, "windowSize": 20, "alertThreshold": 0.8, "rollingAgreementRate": 1

# ...classify a lot of traffic...
curl -s localhost:4567/drift/status | python3 -m json.tool
# -> "rollingEvaluations": 20, "rollingAgreementRate": 0.65, "alertActive": true
# -> if an alert webhook is registered (see feature 13), it just received a signed "drift_alert" POST
```

### 16. Multi-sidecar ensemble voting

Supports registering more than one independent sidecar classifier and **combining** their verdicts for the same
request via a real, explainable weighted vote — as opposed to feature 12 (canary/A-B routing), which **splits**
traffic so each request is served by exactly one of two versions. `POST /router/ensemble { "members": [{ "weight":
<n>, "config": {...} }, ...] }` registers 1+ extra members alongside the primary; from then on, every classification
runs **all** members concurrently and combines their answers: each member's vote for its own label contributes
`weight × confidence` toward that label's score, the label with the highest total score wins, and the combined
confidence is that winning score as a fraction of the total weight — so members that corroborate each other can push
the combined confidence *above* what the primary alone reported (resolving a case the primary alone would have needed
to escalate), while a genuine disagreement between members correctly drags the combined confidence down, and the
router only escalates to the foundation model when the **ensemble itself** — not any single member — can't reach
sufficient combined confidence. `RouteResult.sidecar.ensembleVotes` reports every member's individual vote for full
explainability, not just the combined answer.

**Canary vs. ensemble, concretely:** canary answers "should candidate-v2 serve some traffic so I can compare it
against v1 before promoting it?" (one answer serves each request); ensemble answers "can 3 independently-tuned
sidecars agree well enough, together, to skip the foundation model more often than any one of them could alone?"
(every member's answer contributes to one combined verdict, every request). The two are independent — a router with
both configured would run each, though this demo treats ensemble as taking priority when configured.

```bash
# Register 2 extra voting members (a real deployment would point these at genuinely different trained endpoints)
curl -s -X POST localhost:4567/router/ensemble -H "Content-Type: application/json" \
  -d '{"members": [{"weight": 1, "config": {"confidenceScale": 1.5}}, {"weight": 0.5, "config": {}}]}' | python3 -m json.tool
# -> "enabled": true, "memberCount": 3

curl -s -X POST localhost:4567/classify -H "Content-Type: application/json" \
  -d '{"text": "reminder: the grocery order today, though there is a leaking pipe outside too."}' | python3 -m json.tool
# -> "sidecar": {"label": "routine", "confidence": 0.72, "ensembleVotes": [
#      {"name": "primary", "label": "routine", "confidence": 0.6, "weight": 1},
#      {"name": "member-1", "label": "routine", "confidence": 0.9, "weight": 1},
#      {"name": "member-2", "label": "routine", "confidence": 0.6, "weight": 0.5}]}
# -> combined confidence (0.6*1 + 0.9*1 + 0.6*0.5) / 2.5 = 0.72 clears the 0.7 threshold, even though the
#    primary alone (0.60) would have needed to escalate or consult the reviewer tier
```

### 17. Cost-optimization recommender

`GET /recommendations/cost` generates a concrete, numerically-computed suggestion from the router's own accumulated
traffic — never a canned message. It reasons over a bounded log of every recent escalated request's real sidecar
confidence and marginal cost, plus the exact same pooled feedback/shadow-evaluation accuracy signal the adaptive-
threshold suggestion (feature 4) already collects, and picks one of two real levers: if recent escalations cluster in
the reviewer band (`[reviewerConfidenceThreshold, threshold)`) with **no reviewer configured**, it recommends adding
one (with real projected `REVIEWER_COST_USD` vs. `FOUNDATION_COST_USD` savings); otherwise, if lowering the confidence
threshold (never below the reviewer band's own floor — the architecture's own "essentially no real signal" line) would
have let the sidecar resolve a solid share of them directly, it recommends that instead, with the specific projected
call-reduction percentage, dollar savings, *and* an honestly-labeled accuracy-risk estimate (or "unknown" when there
isn't yet enough data to estimate it). When neither lever has real headroom, it says so (`"no_change"`) rather than
manufacturing a suggestion.

```bash
curl -s localhost:4567/recommendations/cost | python3 -m json.tool
# -> {"recommendationType": "lower_threshold", "sampleSize": 42, "currentThreshold": 0.7,
#     "suggestedThreshold": 0.6, "projectedFoundationCallReductionPct": 61.9,
#     "projectedCostSavingsUsd": 0.2856, "projectedAccuracyRiskPct": 4.2, "accuracySampleSize": 18,
#     "rationale": "Of the last 42 escalated request(s), 26 (61.9%) had sidecar confidence >= 0.60. ..."}
```

### 18. Per-request audit trail export

`GET /audit/export?since=<ISO timestamp or epoch ms>&limit=<n>` produces a compliance/cost-review-ready report of
individual routing decisions — which path was taken, confidence, cost/latency, and the circuit-breaker/budget state
in effect *at the time* — reusing the exact same demo-grade, single-file, no-external-database persistence philosophy
`metricsPersistence.ts` already established (see `auditTrail.ts`), rather than inventing a second storage mechanism.
The one real difference: metrics persist a fixed-size *snapshot* (rewritten whole on every save), while an audit
trail is an ever-growing *log*, so it's appended as JSON Lines (one compact record per line) instead — still a single
plain-text file, still trivially inspectable with `cat`/`tail`/`jq`. Every routing decision is recorded, cache hits
included (a compliance reviewer needs to see a request was served from cache, not have it silently vanish from the
trail).

```bash
curl -s "localhost:4567/audit/export?since=2026-09-01T00:00:00Z" | python3 -m json.tool
# -> {"recordCount": 213, "totalCostUsd": 0.3841, "pathCounts": {"sidecar": 180, "reviewer": 12, "foundation": 19, "fallback": 2},
#     "records": [{"requestId": "...", "timestamp": "...", "callerId": "mobile-app", "path": "sidecar",
#                   "confidence": 0.92, "totalCostUsd": 0.0001, "totalLatencyMs": 45, "cacheHit": false,
#                   "circuitState": "closed", "budgetEnabled": true, "budgetSpendUsd": 0.0231, ...}, ...]}
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
  both the library directly and the full HTTP surface (109 passing checks). Zero TypeScript errors under `strict:
  true`. Beyond the base routing decision, eighteen genuinely-working production-grade features (see [Advanced
  features](#advanced-features)): a TTL response cache, a circuit breaker with a sidecar-fallback chain, background
  shadow evaluation, a feedback-driven adaptive-threshold suggestion, simulated SSE streaming, per-caller rate
  limiting, an optional three-tier cascade with a cheaper "reviewer" model, cost-budget enforcement with
  auto-throttling (scoped per caller), keyword-level classification explainability, demo-grade file persistence of
  cumulative metrics, canary/A-B sidecar routing, HMAC-signed outbound alert webhooks, a Prometheus-format metrics
  export, sampled rolling-window drift detection with the same alerting mechanism, multi-sidecar ensemble voting with
  a real weighted-confidence combination formula, a self-analyzing cost-optimization recommender that reasons over
  the router's own accumulated escalation history, and a compliance-ready per-request audit trail export — each with
  its own passing test coverage, not stubbed.
- **Design:** The interfaces mirror the real `@aws-sdk/client-sagemaker-runtime` / `@aws-sdk/client-bedrock-runtime`
  request/response shapes closely enough that going live is a class-body swap, not a redesign — the architectural
  seam is the deliverable, not just working code behind it, and the reviewer tier reuses that exact same seam (a
  second `FoundationModelProvider` instance) rather than inventing a new one; the canary feature reuses the identical
  seam again (a second `SidecarClassifier`), and ensemble voting reuses it a third time while staying explicitly
  distinct from canary in what it does with the extra classifier(s) (combine vs. split traffic). The audit trail
  deliberately reuses `metricsPersistence.ts`'s established file-based persistence philosophy rather than introducing
  a second storage mechanism, adapting only the write pattern (append vs. rewrite) to the log's different data shape.
  Round 5's features are each a *different kind* of production pattern than rounds 1–4's infrastructure hardening —
  automated drift monitoring, ensemble consensus, self-analyzing cost recommendations, and compliance auditability —
  chosen specifically to demonstrate genuinely new capability rather than more of the same category of feature. Every
  feature is honestly scoped: the adaptive-threshold heuristic, the streaming endpoint's chunking-after-the-fact, the
  fixed-window budget/rate-limit choice, the reviewer's fixed cost/latency profile, the per-request (not
  per-transition) budget-alert firing, the recommender's reuse (not independent measurement) of pooled accuracy data
  for a hypothetical lower threshold, and the audit log's best-effort (not atomic) file writes are all explicitly
  documented as illustrative simplifications, not claims of statistical rigor or a fully hardened production system.
- **Potential Impact:** This is a genuinely reusable AWS architecture pattern, not tied to one feature — any track
  with an AI feature that mostly handles predictable cases (which is most of them) can drop this router in front of
  its own model calls and get a concrete, measurable cost/latency win, as `GET /metrics` demonstrates numerically.
  Round 5's features map directly onto what a real AWS ML platform team maintaining a sidecar-in-front-of-Bedrock
  pattern in production would actually ask for next: "how do I know if the cheap model has drifted from what the
  expensive model would say, without re-paying for the expensive model on every request?" (drift detection); "can I
  combine several cheap models instead of betting everything on one classifier?" (ensemble voting); "where's my next
  concrete lever to cut spend, and what's the risk?" (the cost recommender); and "can I show an auditor exactly what
  happened on any given request?" (the audit trail) — none of which are addressed by simply hardening the existing
  routing/caching/budgeting infrastructure further.
- **Quality of Idea:** Directly addresses the AWS Builder mini-challenge's own framing — "off-the-shelf foundation
  models are often overkill for narrow, well-defined tasks" — with a demo task grounded enough (urgency triage) to
  be concretely testable, while staying generalizable enough to be a pattern rather than a single feature. Round 5
  specifically pushes past "more production hardening" into functionality that's genuinely novel within this
  submission's own history: sampled drift monitoring (not full shadow evaluation of every request), vote combination
  (not traffic splitting), a recommender that computes its own numbers from its own accumulated data (not a canned
  tip), and an audit trail sized for a compliance conversation rather than an operator's dashboard.
