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
  foundationModel.ts     FoundationModelProvider interface + MockBedrockProvider (template-based richer answer)
  router.ts              ModelRouter: routing decision + cumulative metrics — pure/importable, framework-agnostic
  server.ts              Express app factory wrapping ModelRouter: POST /classify, GET /metrics
  index.ts               Entry point: wires up the mocks, creates the app, starts listening
test/
  smoke.test.ts          Unit-style router tests (no HTTP) + an end-to-end HTTP test via fetch()
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

## Testing

```bash
npm test
```

`test/smoke.test.ts` covers, in order:

1. **Router unit tests (no HTTP):** a clear high-confidence input takes the sidecar path; a zero-keyword-signal
   input escalates to the foundation model; the *same* borderline-confidence input (`confidence` 0.55) routes to the
   foundation model at the default threshold (0.7) but to the sidecar path at a lowered threshold (0.5); and
   cumulative metrics correctly track path counts plus the actual-cost-vs-always-foundation-cost math.
2. **End-to-end HTTP test:** starts the real Express app via `createApp()` on an ephemeral port (`app.listen(0)`)
   and drives it with real `fetch()` calls — a missing/empty `text` field and an out-of-range `threshold` both
   return 400; the fast path and escalation path both work over real HTTP; a request-level `threshold` override
   changes routing; and `GET /metrics` reflects the four prior `/classify` calls correctly.

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

Everything else — `router.ts`, `server.ts`, the metrics math — is completely unaware it's talking to mocks; it only
depends on the two interfaces in `sidecarClassifier.ts` and `foundationModel.ts`.

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
  both the library directly and the full HTTP surface. Zero TypeScript errors under `strict: true`.
- **Design:** The interfaces mirror the real `@aws-sdk/client-sagemaker-runtime` / `@aws-sdk/client-bedrock-runtime`
  request/response shapes closely enough that going live is a class-body swap, not a redesign — the architectural
  seam is the deliverable, not just working code behind it.
- **Potential Impact:** This is a genuinely reusable AWS architecture pattern, not tied to one feature — any track
  with an AI feature that mostly handles predictable cases (which is most of them) can drop this router in front of
  its own model calls and get a concrete, measurable cost/latency win, as `GET /metrics` demonstrates numerically.
- **Quality of Idea:** Directly addresses the AWS Builder mini-challenge's own framing — "off-the-shelf foundation
  models are often overkill for narrow, well-defined tasks" — with a demo task grounded enough (urgency triage) to
  be concretely testable, while staying generalizable enough to be a pattern rather than a single feature.
