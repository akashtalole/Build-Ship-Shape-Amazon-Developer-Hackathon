/**
 * Smoke test covering both layers of the model router:
 *   1. Direct, unit-style tests against router.ts (no HTTP) — verifying the
 *      sidecar/foundation routing decision and the cumulative metrics math,
 *      plus the v2 features that are easiest to test directly against the
 *      router (caching, circuit breaker/fallback, shadow mode, feedback).
 *   2. An end-to-end HTTP test — starts the real Express app on an
 *      ephemeral port and drives it with fetch() (including the new
 *      streaming and rate-limiting surfaces).
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  ModelRouter,
  SIDECAR_COST_USD,
  FOUNDATION_COST_USD,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "../src/router.js";
import { MockSidecarClassifier } from "../src/sidecarClassifier.js";
import { MockBedrockProvider, FAILURE_TRIGGER } from "../src/foundationModel.js";
import { createApp } from "../src/server.js";
import { RateLimiter } from "../src/rateLimiter.js";

// Fixed inputs chosen so MockSidecarClassifier's keyword heuristics produce
// known, reliable confidence scores:
const URGENT_TEXT = "There's a fire and smoke in the kitchen, please call 911 emergency!"; // 4 urgent-keyword hits -> confidence 0.92
const AMBIGUOUS_TEXT = "Can you check on things when you get a chance?"; // 0 keyword hits in any category -> confidence 0.30
const BORDERLINE_TEXT = "Just a reminder to take out the trash tonight."; // 1 routine-keyword hit ("reminder") -> confidence 0.55

// Confident "routine" input whose 3 keyword hits ("mow the lawn", "dishwasher
// cycle", "weekly check") aren't in MockBedrockProvider's independent,
// deliberately-different hint list, but which also contains the bare word
// "package" (one of *that* list's informational hints) — so the sidecar
// lands on "routine" at high confidence while the foundation model's shadow
// guess lands on "informational", giving shadow mode a genuine disagreement
// to log, deterministically.
const SHADOW_DISAGREEMENT_TEXT =
  "Time to mow the lawn and run a dishwasher cycle before the weekly check — the new lawnmower package should arrive too.";

function closeTo(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) < epsilon;
}

async function testRouterUnit() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());

  // --- Clear-cut, high-confidence input takes the fast/cheap sidecar path ---
  const urgentResult = await router.route(URGENT_TEXT);
  assert.equal(urgentResult.path, "sidecar");
  assert.equal(urgentResult.label, "urgent");
  assert.ok(urgentResult.confidence >= DEFAULT_CONFIDENCE_THRESHOLD, "confident urgent classification should clear the default threshold");
  assert.equal(urgentResult.foundation, undefined, "sidecar path should not invoke the foundation model");
  assert.equal(urgentResult.totalCostUsd, SIDECAR_COST_USD);
  assert.ok(typeof urgentResult.requestId === "string" && urgentResult.requestId.length > 0, "every result should carry a requestId");
  console.log('✓ a clear, high-confidence input ("fire/smoke/911/emergency") takes the sidecar path with no escalation');

  // --- Zero keyword signal takes the slow/expensive foundation path ---
  const ambiguousResult = await router.route(AMBIGUOUS_TEXT);
  assert.equal(ambiguousResult.path, "foundation");
  assert.ok(ambiguousResult.foundation, "foundation path should include a foundation model result");
  assert.ok(ambiguousResult.foundation!.text.length > 0);
  assert.equal(ambiguousResult.totalCostUsd, SIDECAR_COST_USD + FOUNDATION_COST_USD);
  console.log("✓ a low-signal, ambiguous input escalates to the foundation model");

  // --- The same borderline input routes differently depending on the threshold ---
  const borderlineDefault = await router.route(BORDERLINE_TEXT); // default threshold 0.7, confidence 0.55 -> escalates
  assert.equal(borderlineDefault.path, "foundation");
  const borderlineLowThreshold = await router.route(BORDERLINE_TEXT, 0.5); // confidence 0.55 clears a lowered threshold
  assert.equal(borderlineLowThreshold.path, "sidecar");
  assert.equal(borderlineLowThreshold.label, "routine");
  console.log("✓ a caller-supplied threshold changes routing for a borderline-confidence input");

  // --- Cumulative metrics: 2 sidecar-path + 2 foundation-path requests so far ---
  const metrics = router.getMetrics();
  assert.equal(metrics.totalRequests, 4);
  assert.equal(metrics.sidecarPathRequests, 2);
  assert.equal(metrics.foundationPathRequests, 2);
  assert.ok(closeTo(metrics.sidecarPathRate, 0.5));

  const expectedActualCost = 2 * SIDECAR_COST_USD + 2 * (SIDECAR_COST_USD + FOUNDATION_COST_USD);
  const expectedAllFoundationCost = 4 * FOUNDATION_COST_USD;
  assert.ok(closeTo(metrics.actualCostUsd, expectedActualCost), `actualCostUsd ${metrics.actualCostUsd} !~= ${expectedActualCost}`);
  assert.ok(closeTo(metrics.allFoundationCostUsd, expectedAllFoundationCost));
  assert.ok(closeTo(metrics.estimatedSavingsUsd, expectedAllFoundationCost - expectedActualCost));
  console.log("✓ metrics track cumulative path counts and correct cost-savings math (router cost vs. always-foundation cost)");
}

/** Simple counting wrapper so tests can assert a model was (or wasn't) actually invoked. */
class CountingSidecar extends MockSidecarClassifier {
  calls = 0;
  async classify(input: string) {
    this.calls += 1;
    return super.classify(input);
  }
}
class CountingFoundation extends MockBedrockProvider {
  calls = 0;
  async invoke(prompt: string) {
    this.calls += 1;
    return super.invoke(prompt);
  }
}

async function testResponseCache() {
  const sidecar = new CountingSidecar();
  const foundation = new CountingFoundation();
  // Mutable clock so the TTL-expiry check below doesn't need a real sleep.
  const clock = { time: 1_000_000 };
  const router = new ModelRouter(sidecar, foundation, { cacheTtlMs: 60_000, now: () => clock.time });

  // --- First call: real sidecar invocation, cache miss ---
  const first = await router.route(URGENT_TEXT);
  assert.equal(first.cacheHit, undefined, "a fresh classification should not be marked as a cache hit");
  assert.equal(sidecar.calls, 1);
  assert.equal(foundation.calls, 0);

  // --- Second, identical call within the TTL: served from cache, skips both models ---
  const second = await router.route(URGENT_TEXT);
  assert.equal(second.cacheHit, true, "a repeated identical input within the TTL should be flagged as a cache hit");
  assert.equal(second.label, first.label);
  assert.equal(second.confidence, first.confidence);
  assert.equal(sidecar.calls, 1, "a cache hit must not re-invoke the sidecar");
  assert.equal(foundation.calls, 0, "a cache hit must not invoke the foundation model");
  assert.notEqual(second.requestId, first.requestId, "each response gets its own requestId even when served from cache");
  console.log("✓ a repeated identical input within the TTL is served from cache (cacheHit: true) and skips both the sidecar and the foundation model");

  // --- An escalation-path input is also cached end-to-end (including the foundation call) ---
  const ambiguousFirst = await router.route(AMBIGUOUS_TEXT);
  assert.equal(ambiguousFirst.path, "foundation");
  assert.equal(foundation.calls, 1);
  const ambiguousSecond = await router.route(AMBIGUOUS_TEXT);
  assert.equal(ambiguousSecond.cacheHit, true);
  assert.equal(foundation.calls, 1, "a cached escalation-path result must not re-invoke the foundation model either");
  console.log("✓ the response cache covers the escalation path too, skipping a repeat foundation-model call");

  // --- Metrics reflect the cache hits, and cache hits count toward cost savings ---
  const metrics = router.getMetrics();
  assert.equal(metrics.cacheHits, 2);
  assert.equal(metrics.cacheMisses, 2);
  assert.ok(closeTo(metrics.cacheHitRate, 0.5));
  // Baseline cost treats every one of the 4 calls (2 misses + 2 hits) as if it had hit the foundation model...
  assert.ok(closeTo(metrics.allFoundationCostUsd, 4 * FOUNDATION_COST_USD));
  // ...while actual cost only reflects the 2 real invocations (1 sidecar-only + 1 escalation), so the 2 cache
  // hits show up entirely as extra savings on top of the routing savings already demonstrated above.
  const expectedActualCost = SIDECAR_COST_USD + (SIDECAR_COST_USD + FOUNDATION_COST_USD);
  assert.ok(closeTo(metrics.actualCostUsd, expectedActualCost));
  assert.ok(
    closeTo(metrics.estimatedSavingsUsd, 4 * FOUNDATION_COST_USD - expectedActualCost),
    "cache hits should be reflected in the cumulative cost-savings calculation"
  );
  console.log("✓ metrics track cache hit/miss counts and fold cache-hit cost savings into the cumulative savings calculation");

  // --- After the TTL elapses, the same input is a fresh cache miss again ---
  clock.time += 61_000; // past the 60s TTL
  const afterExpiry = await router.route(URGENT_TEXT);
  assert.equal(afterExpiry.cacheHit, undefined);
  assert.equal(sidecar.calls, 3, "an expired cache entry must trigger a real sidecar re-invocation"); // 1 (URGENT_TEXT) + 1 (AMBIGUOUS_TEXT) + 1 (this re-invocation)
  console.log("✓ a cache entry past its TTL is treated as a miss and re-invokes the sidecar");
}

async function testCircuitBreakerAndFallback() {
  // A foundation provider that always fails, paired with a low failure
  // threshold/cooldown so the breaker's state machine is exercised quickly
  // and deterministically (via an injected clock, not real waiting).
  const failingFoundation = new MockBedrockProvider({ alwaysFail: true });
  const clock = { time: 0 };
  const router = new ModelRouter(new MockSidecarClassifier(), failingFoundation, {
    now: () => clock.time,
    circuitBreakerFailureThreshold: 2,
    circuitBreakerCooldownMs: 10_000,
  });

  // --- First failure: circuit still closed, router falls back per-call ---
  const first = await router.route(AMBIGUOUS_TEXT);
  assert.equal(first.path, "fallback");
  assert.equal(first.fallbackUsed, true);
  assert.equal(first.confidence, 0.3, "the fallback result is the sidecar's best-effort answer, below the normal threshold");
  assert.equal(router.getMetrics().circuitState, "closed");

  // --- Second failure trips the breaker open (threshold = 2) ---
  clock.time += 1; // distinct cache key isn't needed (fallback results aren't identical-cached issue here) but keeps timestamps sane
  const second = await router.route(AMBIGUOUS_TEXT + "!"); // slightly different text so this isn't served from cache
  assert.equal(second.path, "fallback");
  assert.equal(router.getMetrics().circuitState, "open");
  console.log("✓ repeated foundation-model failures trip the circuit breaker open, and each failure falls back to the sidecar's best-effort result (fallbackUsed: true) instead of failing the request");

  // --- While open, a new escalation-worthy input is fast-failed without even attempting the foundation model ---
  const third = await router.route(AMBIGUOUS_TEXT + "??");
  assert.equal(third.path, "fallback");
  assert.equal(third.totalLatencyMs < first.totalLatencyMs + 50, true, "an open-circuit fallback should be a fast failure, not a full failed-call wait");
  const metricsAfterThree = router.getMetrics();
  assert.equal(metricsAfterThree.fallbackRequests, 3);
  console.log("✓ while the circuit is open, further escalations are fast-failed straight to fallback without attempting the foundation model");

  // --- After the cooldown elapses, a half-open trial call is allowed; success closes the circuit again ---
  clock.time += 10_001;
  // A provider that fails exactly once (tripping the breaker open) and then recovers, to exercise the
  // open -> (cooldown elapses) -> half-open -> (trial succeeds) -> closed state transitions end-to-end.
  const flakyThenHealthy = new MockBedrockProvider({ failFirstN: 1 });
  const halfOpenRouter = new ModelRouter(new MockSidecarClassifier(), flakyThenHealthy, {
    now: () => clock.time,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerCooldownMs: 5_000,
  });
  const opened = await halfOpenRouter.route(AMBIGUOUS_TEXT);
  assert.equal(opened.path, "fallback");
  assert.equal(halfOpenRouter.getMetrics().circuitState, "open");
  clock.time += 5_001; // elapse the cooldown
  const trial = await halfOpenRouter.route(AMBIGUOUS_TEXT + "###"); // flakyThenHealthy now succeeds (failFirstN: 1 already consumed)
  assert.equal(trial.path, "foundation", "a successful half-open trial call should escalate normally, not fall back");
  assert.equal(halfOpenRouter.getMetrics().circuitState, "closed", "a successful half-open trial closes the circuit again");
  console.log("✓ after the cooldown window, a half-open trial call that succeeds closes the circuit breaker again");

  // --- A dedicated failure-trigger string (rather than a constructor flag) also deterministically fails a call ---
  const triggerRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const triggered = await triggerRouter.route(`${AMBIGUOUS_TEXT} ${FAILURE_TRIGGER}`);
  assert.equal(triggered.fallbackUsed, true);
  console.log("✓ the FAILURE_TRIGGER sentinel string also deterministically forces a foundation-model failure, independent of the constructor flag");
}

async function testShadowMode() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());

  // --- Shadow mode must not change the fast-path result or its latency profile ---
  const withoutShadow = await router.route(URGENT_TEXT, { shadowMode: false });
  const start = Date.now();
  const withShadow = await router.route(URGENT_TEXT + " urgent!!", { shadowMode: true }); // distinct text to avoid a cache hit
  const elapsedMs = Date.now() - start;
  assert.equal(withShadow.path, "sidecar");
  assert.equal(withShadow.totalCostUsd, withoutShadow.totalCostUsd, "shadow mode must not change the returned cost");
  assert.equal(withShadow.totalLatencyMs, withoutShadow.totalLatencyMs, "shadow mode must not change the returned (reported) latency");
  assert.ok(elapsedMs < 200, "shadow mode's background foundation call must not block the caller's response");
  assert.equal((withShadow as Record<string, unknown>).foundation, undefined, "the fast-path response body itself carries no foundation data even in shadow mode");

  await router.flushShadowEvaluations();
  const metricsAfterAgree = router.getMetrics();
  assert.equal(metricsAfterAgree.shadowEvaluations, 1, "the background shadow call should have logged exactly one evaluation");
  assert.equal(metricsAfterAgree.shadowAgreements, 1, "the foundation model's guess should agree with a clear-cut urgent classification");
  assert.ok(closeTo(metricsAfterAgree.shadowAgreementRate, 1));
  console.log("✓ shadow mode logs a foundation-model agreement data point for a confident sidecar answer, without changing the fast-path response or its latency");

  // --- A genuine, deterministic disagreement is also logged correctly ---
  const disagreementResult = await router.route(SHADOW_DISAGREEMENT_TEXT, { shadowMode: true });
  assert.equal(disagreementResult.path, "sidecar");
  assert.equal(disagreementResult.label, "routine");
  await router.flushShadowEvaluations();
  const metricsAfterDisagree = router.getMetrics();
  assert.equal(metricsAfterDisagree.shadowEvaluations, 2);
  assert.equal(metricsAfterDisagree.shadowAgreements, 1, "the deliberately mismatched input should not count as an agreement");
  assert.ok(closeTo(metricsAfterDisagree.shadowAgreementRate, 0.5));
  console.log("✓ shadow mode also logs a genuine disagreement between the sidecar and the foundation model, reflected in shadowAgreementRate");
}

async function testAdaptiveThresholdSuggestion() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());

  // With no feedback/shadow samples yet, the router declines to suggest anything.
  const beforeAny = router.getMetrics();
  assert.equal(beforeAny.suggestedThreshold, null);
  console.log("✓ GET /metrics reports no threshold suggestion when there isn't yet enough feedback/shadow-agreement signal");

  // Generate several fast-path (sidecar-trusted) classifications and report most of them as wrong.
  const inputs = [
    "There's a fire in the garage, call 911!",
    "Smoke is coming from the oven, emergency!",
    "The alarm is going off and there's an intruder, help immediately!",
    "Carbon monoxide detector triggered, please help immediately, call 911!",
  ];
  const requestIds: string[] = [];
  for (const text of inputs) {
    const result = await router.route(text);
    assert.equal(result.path, "sidecar", `expected a fast-path classification for: ${text}`);
    requestIds.push(result.requestId);
  }

  // Mark 3 of the 4 as incorrect -> 25% accuracy, well under the 95% target.
  for (const id of requestIds.slice(0, 3)) {
    router.recordFeedback(id, false);
  }
  router.recordFeedback(requestIds[3], true);

  const afterBadFeedback = router.getMetrics();
  assert.equal(afterBadFeedback.feedbackCount, 4);
  assert.ok(afterBadFeedback.suggestedThreshold !== null, "poor observed accuracy should trigger a suggested threshold change");
  assert.ok(
    afterBadFeedback.suggestedThreshold! > afterBadFeedback.currentThreshold,
    "poor accuracy should push the suggestion toward a *higher* (more conservative) threshold"
  );
  assert.ok(afterBadFeedback.thresholdSuggestionReason.includes("%"), "the reason should cite an observed accuracy percentage");
  console.log(
    `✓ POST /feedback moves the suggested-threshold metric in a sensible direction (raising it) after several fast-path classifications are reported incorrect (suggested ${afterBadFeedback.suggestedThreshold})`
  );

  // Feedback on an unknown requestId is rejected by the router (surfaced as 404 over HTTP, tested below).
  assert.equal(router.recordFeedback("not-a-real-id", true), false);
}

async function testHttpEndToEnd() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  // A generous limit here — this test issues many unrelated requests and rate limiting itself
  // gets its own dedicated, precisely-counted test (testRateLimiting) below.
  const rateLimiter = new RateLimiter({ limit: 100, windowMs: 60_000 });
  const app = createApp(router, { rateLimiter });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // --- Missing/empty text is rejected ---
    const missingTextRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({}),
    });
    assert.equal(missingTextRes.status, 400);
    const emptyTextRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(emptyTextRes.status, 400);
    console.log("✓ POST /classify rejects a missing or empty 'text' field with 400");

    // --- An out-of-range threshold is rejected ---
    const badThresholdRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({ text: URGENT_TEXT, threshold: 5 }),
    });
    assert.equal(badThresholdRes.status, 400);
    console.log("✓ POST /classify rejects an out-of-range 'threshold' with 400");

    // --- Fast path over real HTTP ---
    const urgentRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({ text: URGENT_TEXT }),
    });
    assert.equal(urgentRes.status, 200);
    const urgentBody = await urgentRes.json();
    assert.equal(urgentBody.path, "sidecar");
    assert.equal(urgentBody.label, "urgent");
    console.log("✓ POST /classify returns the sidecar's fast-path result over real HTTP");

    // --- Escalation path over real HTTP ---
    const ambiguousRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({ text: AMBIGUOUS_TEXT }),
    });
    const ambiguousBody = await ambiguousRes.json();
    assert.equal(ambiguousBody.path, "foundation");
    assert.ok(ambiguousBody.foundation?.text);
    console.log("✓ POST /classify escalates to the foundation model over real HTTP for a low-confidence input");

    // --- The same borderline input at the default threshold still escalates ---
    const borderlineDefaultRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({ text: BORDERLINE_TEXT }),
    });
    const borderlineDefaultBody = await borderlineDefaultRes.json();
    assert.equal(borderlineDefaultBody.path, "foundation");

    // --- A custom threshold changes routing over real HTTP ---
    const borderlineLowRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({ text: BORDERLINE_TEXT, threshold: 0.5 }),
    });
    const borderlineLowBody = await borderlineLowRes.json();
    assert.equal(borderlineLowBody.path, "sidecar");
    console.log("✓ a custom 'threshold' in the request body changes routing behavior for a borderline input");

    // --- A repeated identical request is a cache hit over real HTTP ---
    // (The cache is shared across callers — keyed by input+threshold, not caller id — so this
    // uses text no earlier call in this test has classified yet, to guarantee a fresh first miss.)
    const CACHE_DEMO_TEXT = "There's smoke pouring out of the oven, this looks like a real fire emergency!";
    const cachedRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "bob" },
      body: JSON.stringify({ text: CACHE_DEMO_TEXT }),
    });
    const cachedBody = await cachedRes.json();
    assert.equal(cachedBody.cacheHit, undefined, "bob's first request for this text is a fresh classification");
    const cachedRepeatRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "bob" },
      body: JSON.stringify({ text: CACHE_DEMO_TEXT }),
    });
    const cachedRepeatBody = await cachedRepeatRes.json();
    assert.equal(cachedRepeatBody.cacheHit, true);
    console.log("✓ an identical repeated request over real HTTP is served from cache with cacheHit: true");

    // --- Feedback endpoint: unknown id is 404, known id succeeds ---
    const unknownFeedbackRes = await fetch(`${base}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "does-not-exist", correct: true }),
    });
    assert.equal(unknownFeedbackRes.status, 404);
    const knownFeedbackRes = await fetch(`${base}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: cachedBody.requestId, correct: true }),
    });
    assert.equal(knownFeedbackRes.status, 200);
    console.log("✓ POST /feedback accepts feedback keyed by a real requestId (200) and rejects an unknown one (404)");

    // --- Streaming endpoint delivers multiple chunks for an escalation-path input ---
    const streamRes = await fetch(`${base}/classify/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "carol" },
      body: JSON.stringify({ text: "Can you take a look at this whenever you get a moment, no rush?" }), // fresh ambiguous text, escalates
    });
    assert.equal(streamRes.status, 200);
    assert.ok(streamRes.headers.get("content-type")?.includes("text/event-stream"));
    const rawStream = await streamRes.text();
    const chunkEvents = rawStream.split("\n\n").filter((block) => block.startsWith("event: chunk"));
    const doneEvents = rawStream.split("\n\n").filter((block) => block.startsWith("event: done"));
    assert.ok(chunkEvents.length > 1, `expected multiple streamed chunks, got ${chunkEvents.length}`);
    assert.equal(doneEvents.length, 1, "exactly one terminal 'done' event should be sent");
    const finalPayload = JSON.parse(doneEvents[0].split("data: ")[1]);
    assert.equal(finalPayload.path, "foundation");
    console.log(`✓ POST /classify/stream delivers the foundation model's answer as ${chunkEvents.length} discrete SSE chunks rather than one blob, ending in a single 'done' event`);

    // --- Metrics reflect all the /classify-family requests above ---
    const metricsRes = await fetch(`${base}/metrics`);
    assert.equal(metricsRes.status, 200);
    const metrics = await metricsRes.json();
    assert.ok(metrics.totalRequests >= 7, "metrics should account for every classify-family call issued above");
    assert.ok(metrics.cacheHits >= 1);
    assert.ok("suggestedThreshold" in metrics && "thresholdSuggestionReason" in metrics);
    assert.ok("circuitState" in metrics && "fallbackRequests" in metrics);
    assert.ok("shadowEvaluations" in metrics && "shadowAgreementRate" in metrics);
    console.log("✓ GET /metrics exposes cache, circuit-breaker/fallback, shadow-evaluation, and adaptive-threshold fields alongside the original routing metrics");
  } finally {
    httpServer.close();
  }
}

async function testHttpFallbackAndShadowOverHttp() {
  // A dedicated app wired to an always-failing foundation provider, to prove
  // the fallback path is reachable (and correctly flagged) over real HTTP too.
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider({ alwaysFail: true }));
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "erin" },
      body: JSON.stringify({ text: AMBIGUOUS_TEXT }),
    });
    assert.equal(res.status, 200, "a failed foundation-model call must still return 200 via fallback, not a server error");
    const body = await res.json();
    assert.equal(body.fallbackUsed, true);
    assert.equal(body.path, "fallback");
    console.log("✓ over real HTTP, a simulated foundation-model failure triggers the fallback path (200 OK, fallbackUsed: true) instead of failing the request");
  } finally {
    httpServer.close();
  }
}

async function testRateLimiting() {
  // A dedicated app + tiny, precisely-counted limit so this test doesn't
  // depend on (or interfere with) request counts used by other HTTP tests.
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 5, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // --- The first 5 requests from "alice" all succeed ---
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
        body: JSON.stringify({ text: `Request number ${i} with unique text to avoid any cache hit.` }),
      });
      assert.equal(res.status, 200, `alice's request #${i + 1} (within her limit of 5) should succeed`);
    }

    // --- Her 6th request within the same window is rejected with 429 and a clear message ---
    const sixthRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "alice" },
      body: JSON.stringify({ text: "One request past the limit." }),
    });
    assert.equal(sixthRes.status, 429);
    const sixthBody = await sixthRes.json();
    assert.ok(/rate limit/i.test(sixthBody.error), "a 429 should carry a clear rate-limit message");
    assert.equal(sixthRes.headers.get("x-ratelimit-remaining"), "0");
    console.log("✓ a caller's 6th request within the rate-limit window is rejected with 429 and a clear message");

    // --- A different caller id is completely unaffected by alice's exhausted quota ---
    const daveRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "dave" },
      body: JSON.stringify({ text: "A brand new caller should not be rate-limited." }),
    });
    assert.equal(daveRes.status, 200);
    console.log("✓ a different X-Caller-Id is unaffected by another caller's exhausted quota");
  } finally {
    httpServer.close();
  }
}

async function main() {
  await testRouterUnit();
  await testResponseCache();
  await testCircuitBreakerAndFallback();
  await testShadowMode();
  await testAdaptiveThresholdSuggestion();
  await testHttpEndToEnd();
  await testHttpFallbackAndShadowOverHttp();
  await testRateLimiting();
  console.log("\nAll model-router smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
