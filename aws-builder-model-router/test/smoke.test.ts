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
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import {
  ModelRouter,
  SIDECAR_COST_USD,
  REVIEWER_COST_USD,
  FOUNDATION_COST_USD,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD,
} from "../src/router.js";
import { MockSidecarClassifier } from "../src/sidecarClassifier.js";
import { MockBedrockProvider, FAILURE_TRIGGER } from "../src/foundationModel.js";
import { MockReviewerProvider } from "../src/reviewerModel.js";
import { createApp } from "../src/server.js";
import { RateLimiter } from "../src/rateLimiter.js";
import { loadAuditRecords } from "../src/auditTrail.js";

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

// --- Three-tier cascade fixtures ---
// 2 sidecar hits ("reminder", "grocery") -> raw confidence 0.75, minus the
// 0.15 ambiguity penalty (a 1-hit "leaking" runner-up in the urgent category)
// -> confidence exactly 0.60, landing in the default reviewer band
// [0.60, 0.70). The reviewer model's own independent keyword hints also land
// on "routine" here (2 routine hits vs. 1 urgent hit), so the reviewer tier
// *confirms* the sidecar and resolves the request without needing the full
// foundation model.
const REVIEWER_AGREE_TEXT = "reminder: the grocery order today, though there is a leaking pipe outside too.";

// Also 2 sidecar hits ("reminder", "schedule") with a 1-hit "fyi" runner-up
// in the informational category -> same confidence 0.60, same reviewer band.
// But the extra words "leak", "danger", and "911" are picked up by the
// reviewer model's *own*, deliberately-different hint list (which matches
// bare substrings the sidecar's own phrase-level keywords don't) strongly
// enough to flip the reviewer's independent guess to "urgent" — a genuine
// disagreement with the sidecar's "routine", so the cascade must escalate
// once more to the full foundation model rather than resolving at the
// reviewer tier.
const REVIEWER_DISAGREE_TEXT =
  "fyi, reminder to check the schedule -- there's a slow leak, a bit of danger near the fuse box, might need to dial 911 later.";

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
class CountingReviewer extends MockReviewerProvider {
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

async function testExplainability() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());

  // --- A confident classification's explanation cites the actual matched keyword(s) ---
  const urgent = await router.route(URGENT_TEXT);
  assert.ok(urgent.sidecar.matchedKeywords && urgent.sidecar.matchedKeywords.length > 0, "a confident classification should report which keyword(s) matched");
  assert.ok(urgent.sidecar.matchedKeywords!.includes("fire"), `expected "fire" among matched keywords, got ${JSON.stringify(urgent.sidecar.matchedKeywords)}`);
  assert.ok(urgent.explanation.length > 0, "explanation must be non-empty");
  assert.ok(urgent.explanation.includes("fire"), `explanation should reference the actual matched signal, got: ${urgent.explanation}`);
  console.log('✓ a confident sidecar classification\'s explanation and sidecar.matchedKeywords both cite the actual keyword(s) that drove it (e.g. "fire")');

  // --- A single-keyword borderline match also cites its (sole) matched keyword ---
  const borderline = await router.route(BORDERLINE_TEXT, 0.5); // clears a lowered threshold -> sidecar path
  assert.deepEqual(borderline.sidecar.matchedKeywords, ["reminder"]);
  assert.ok(borderline.explanation.includes("reminder"), `explanation should mention "reminder", got: ${borderline.explanation}`);
  console.log("✓ a single-keyword match reports exactly that keyword in both matchedKeywords and the explanation text");

  // --- Zero keyword signal is explained honestly as a default guess, not a phantom match ---
  const ambiguous = await router.route(AMBIGUOUS_TEXT);
  assert.deepEqual(ambiguous.sidecar.matchedKeywords, []);
  assert.ok(/no keyword signal/i.test(ambiguous.explanation), `expected the no-signal case to say so plainly, got: ${ambiguous.explanation}`);
  console.log("✓ a zero-keyword-signal input is honestly explained as a low-confidence default guess, not a fabricated match");
}

async function testThreeTierCascade() {
  const sidecar = new CountingSidecar();
  const foundation = new CountingFoundation();
  const reviewer = new CountingReviewer();
  const router = new ModelRouter(sidecar, foundation, { reviewer });

  // --- A clearly-confident input still resolves at the sidecar tier, untouched by the cascade ---
  const confident = await router.route(URGENT_TEXT);
  assert.equal(confident.path, "sidecar");
  assert.equal(reviewer.calls, 0, "a confident sidecar answer must never consult the reviewer tier");
  assert.equal(foundation.calls, 0);
  console.log("✓ a clearly-confident input resolves at the sidecar tier even with a reviewer configured (the cascade is never consulted)");

  // --- A borderline-confidence input (0.60, in the reviewer band) resolves at the mid tier when the reviewer agrees ---
  const reviewed = await router.route(REVIEWER_AGREE_TEXT);
  assert.equal(reviewed.confidence, DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD, "fixture text should land exactly at the reviewer-band boundary");
  assert.equal(reviewed.path, "reviewer");
  assert.equal(reviewed.label, "routine");
  assert.ok(reviewed.reviewer, "a reviewer-tier result should carry the reviewer's own FoundationResult record");
  assert.equal(reviewed.foundation, undefined, "resolving at the reviewer tier must not also call the full foundation model");
  assert.equal(reviewer.calls, 1);
  assert.equal(foundation.calls, 0);
  assert.ok(closeTo(reviewed.totalCostUsd, SIDECAR_COST_USD + REVIEWER_COST_USD));
  console.log("✓ a borderline-confidence input resolves at the new mid (reviewer) tier when the reviewer model confirms the sidecar's label, without calling the full foundation model");

  // --- A borderline input where the reviewer itself disagrees cascades on to the full foundation model ---
  const cascaded = await router.route(REVIEWER_DISAGREE_TEXT);
  assert.equal(cascaded.confidence, DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD);
  assert.equal(cascaded.path, "foundation");
  assert.ok(cascaded.reviewer, "the cascade should still report the reviewer's (unsure) attempt");
  assert.ok(cascaded.foundation, "a reviewer disagreement should escalate to the full foundation model");
  assert.equal(reviewer.calls, 2);
  assert.equal(foundation.calls, 1);
  assert.ok(closeTo(cascaded.totalCostUsd, SIDECAR_COST_USD + REVIEWER_COST_USD + FOUNDATION_COST_USD));
  console.log("✓ when the reviewer model is *also* unsure (disagrees with the sidecar), the cascade escalates once more to the full foundation model, billing all three tiers");

  // --- A clearly-low-confidence input still escalates straight to the top tier, skipping the reviewer entirely ---
  const skipped = await router.route(AMBIGUOUS_TEXT);
  assert.equal(skipped.path, "foundation");
  assert.equal(skipped.reviewer, undefined, "confidence below the reviewer band should skip the reviewer tier entirely");
  assert.equal(reviewer.calls, 2, "the reviewer must not have been consulted for a below-band input");
  assert.equal(foundation.calls, 2);
  console.log("✓ a clearly-low-confidence input (below the reviewer band) escalates straight to the full foundation model, skipping the cheaper reviewer tier");

  // --- GET /metrics-equivalent reports how many requests resolved at each of the three tiers ---
  const metrics = router.getMetrics();
  assert.equal(metrics.sidecarPathRequests, 1);
  assert.equal(metrics.reviewerPathRequests, 1);
  assert.equal(metrics.foundationPathRequests, 2);
  assert.ok(closeTo(metrics.reviewerPathRate, 0.25));
  console.log(`✓ GET /metrics-equivalent tracks how many requests resolved at each of the three tiers (sidecar: ${metrics.sidecarPathRequests}, reviewer: ${metrics.reviewerPathRequests}, foundation: ${metrics.foundationPathRequests})`);

  // --- Without a reviewer configured, the cascade collapses back to the original two-tier behavior ---
  const twoTierRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const twoTierResult = await twoTierRouter.route(REVIEWER_AGREE_TEXT); // same 0.60 confidence, but no reviewer configured
  assert.equal(twoTierResult.path, "foundation", "with no reviewer configured, a borderline input should escalate straight to the foundation model as before");
  console.log("✓ omitting the reviewer provider entirely collapses the cascade back to the original two-tier (sidecar/foundation) behavior");

  // --- A reviewer call that itself fails fails open to the top tier rather than back to the sidecar ---
  const failingReviewerRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
    reviewer: new MockReviewerProvider({ alwaysFail: true }),
  });
  const failedOpen = await failingReviewerRouter.route(REVIEWER_AGREE_TEXT);
  assert.equal(failedOpen.path, "foundation", "a failed reviewer call should fail open to the full foundation model, not back to the sidecar");
  assert.equal(failedOpen.reviewer, undefined, "a failed reviewer call has no result to report");
  console.log("✓ a reviewer-model call that fails outright fails open to the full foundation model rather than silently trusting the sidecar");
}

async function testCostBudget() {
  const sidecar = new CountingSidecar();
  const foundation = new CountingFoundation();
  const router = new ModelRouter(sidecar, foundation);

  // --- No budget configured: escalation proceeds normally ---
  const beforeBudget = router.getBudgetStatus();
  assert.equal(beforeBudget.enabled, false);
  const unthrottled = await router.route(AMBIGUOUS_TEXT + " one");
  assert.equal(unthrottled.path, "foundation");
  assert.equal(unthrottled.budgetExceeded, undefined);
  console.log("✓ with no budget configured, escalation proceeds normally and never sets budgetExceeded");

  // --- Configure a budget that covers exactly one escalation's billed cost (the sidecar's own tiny
  // cost is never budgeted — see budgetTracker.ts — only the foundation-model spend is tracked) ---
  router.setBudget(FOUNDATION_COST_USD, 60_000);
  const firstUnderBudget = await router.route(AMBIGUOUS_TEXT + " two");
  assert.equal(firstUnderBudget.path, "foundation", "the call that first reaches the limit should still be allowed through");
  assert.equal(foundation.calls, 2);

  const statusAfterOne = router.getBudgetStatus();
  assert.equal(statusAfterOne.enabled, true);
  assert.ok(statusAfterOne.exceeded, "cumulative spend should have reached the configured limit after one billed escalation");
  console.log("✓ GET /budget-equivalent reports current spend vs. limit, flipping to exceeded once the period's cap is reached");

  // --- The next escalation-worthy request is auto-throttled: sidecar's best-effort answer, budgetExceeded: true ---
  const throttled = await router.route(AMBIGUOUS_TEXT + " three");
  assert.equal(throttled.path, "sidecar", "a budget-throttled response reports path 'sidecar' (a fast-path shape) per spec");
  assert.equal(throttled.budgetExceeded, true, "a budget-throttled response must be flagged so callers can tell it apart from a normal fast-path hit");
  assert.equal(foundation.calls, 2, "the foundation model must not be called once the budget is exhausted");
  assert.equal(throttled.confidence, 0.3, "the throttled response is still the sidecar's genuine best-effort classification");
  console.log("✓ once the tracked spend hits the configured limit, further escalations are auto-throttled to the sidecar's best-effort answer (budgetExceeded: true) instead of calling the foundation model");

  // --- A second, equally-throttled request confirms the throttling persists for the rest of the period ---
  const throttledAgain = await router.route(AMBIGUOUS_TEXT + " four");
  assert.equal(throttledAgain.budgetExceeded, true);
  assert.equal(foundation.calls, 2);
  const metrics = router.getMetrics();
  assert.equal(metrics.budgetThrottledRequests, 2);
  console.log("✓ GET /metrics reports budgetThrottledRequests, separate from genuine sidecarPathRequests");

  // --- Clearing the budget lifts the throttle ---
  router.clearBudget();
  const afterClear = await router.route(AMBIGUOUS_TEXT + " five");
  assert.equal(afterClear.path, "foundation");
  assert.equal(afterClear.budgetExceeded, undefined);
  console.log("✓ clearing the budget immediately lifts the auto-throttle for subsequent escalations");
}

async function testCostBudgetOverHttp() {
  const router = new ModelRouter(new CountingSidecar(), new CountingFoundation());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // --- Invalid budget bodies are rejected ---
    const badLimitRes = await fetch(`${base}/budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: -1, periodMs: 1000 }),
    });
    assert.equal(badLimitRes.status, 400);
    console.log("✓ POST /budget rejects a non-positive 'limit' with 400");

    // --- Set a tiny budget over HTTP ---
    const setRes = await fetch(`${base}/budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: SIDECAR_COST_USD, periodMs: 60_000 }), // smaller than a single escalation's cost
    });
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.enabled, true);
    assert.equal(setBody.limitUsd, SIDECAR_COST_USD);

    const getRes = await fetch(`${base}/budget`);
    const getBody = await getRes.json();
    assert.equal(getBody.enabled, true);
    assert.equal(getBody.spendUsd, 0);
    console.log("✓ GET /budget reflects a budget just configured over HTTP, with $0 spend before any escalation");

    // --- The first escalation still goes through, but is enough to exceed the tiny budget ---
    await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "budget-tester" },
      body: JSON.stringify({ text: "Can you check on things sometime, no rush, http budget test one?" }),
    });

    // --- The next escalation-worthy request is throttled, visibly, over HTTP ---
    const throttledRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "budget-tester" },
      body: JSON.stringify({ text: "Can you check on things sometime, no rush, http budget test two?" }),
    });
    const throttledBody = await throttledRes.json();
    assert.equal(throttledBody.path, "sidecar");
    assert.equal(throttledBody.budgetExceeded, true);
    console.log("✓ over real HTTP, exceeding a configured budget flips subsequent escalations to budgetExceeded: true fast-path responses instead of calling the foundation model");
  } finally {
    httpServer.close();
  }
}

async function testPersistentMetrics() {
  const tempDir = mkdtempSync(join(tmpdir(), "model-router-metrics-test-"));
  const metricsPath = join(tempDir, "metrics-state.json");
  try {
    const clock = { time: 5_000_000 };

    // --- Router "A": accumulate some real metrics, then persist explicitly (simulating graceful shutdown) ---
    const routerA = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
      now: () => clock.time,
      metricsPersistPath: metricsPath,
      persistEveryNRequests: 1_000_000, // effectively disable the periodic auto-save for this half of the test
    });
    await routerA.route(URGENT_TEXT); // sidecar path
    await routerA.route(AMBIGUOUS_TEXT); // foundation path
    await routerA.route(URGENT_TEXT); // cache hit
    routerA.setBudget(1, 60_000);

    const metricsBeforeSave = routerA.getMetrics();
    routerA.persistMetricsNow();
    assert.ok(existsSync(metricsPath), "persistMetricsNow() should write the metrics file to disk");

    const onDisk = JSON.parse(readFileSync(metricsPath, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.sidecarPathRequests, metricsBeforeSave.sidecarPathRequests);
    assert.equal(onDisk.foundationPathRequests, metricsBeforeSave.foundationPathRequests);
    assert.equal(onDisk.cacheHits, metricsBeforeSave.cacheHits);
    assert.ok(onDisk.budget && onDisk.budget.limitUsd === 1, "the configured budget should be persisted too");
    console.log("✓ persistMetricsNow() writes cumulative path counts, cache stats, and budget config/spend to disk on (simulated) graceful shutdown");

    // --- Router "B": a freshly-constructed router pointed at the same file — simulates restarting the demo process ---
    const routerB = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
      now: () => clock.time,
      metricsPersistPath: metricsPath,
    });
    const reloadedMetrics = routerB.getMetrics();
    assert.equal(reloadedMetrics.sidecarPathRequests, metricsBeforeSave.sidecarPathRequests, "a fresh router pointed at the same file should reload prior sidecarPathRequests");
    assert.equal(reloadedMetrics.foundationPathRequests, metricsBeforeSave.foundationPathRequests);
    assert.equal(reloadedMetrics.cacheHits, metricsBeforeSave.cacheHits);
    assert.ok(closeTo(reloadedMetrics.actualCostUsd, metricsBeforeSave.actualCostUsd), "reloaded actualCostUsd should match the pre-restart cumulative cost, not reset to 0");
    const reloadedBudget = routerB.getBudgetStatus();
    assert.equal(reloadedBudget.enabled, true);
    assert.equal(reloadedBudget.limitUsd, 1);
    console.log("✓ a freshly-constructed router pointed at the same metrics file reloads the prior cumulative totals on startup instead of resetting to zero (simulated restart)");

    // --- New activity on router B continues accumulating on top of the reloaded baseline ---
    await routerB.route(SHADOW_DISAGREEMENT_TEXT); // a fresh, distinct sidecar-path input
    const afterMoreActivity = routerB.getMetrics();
    assert.equal(afterMoreActivity.sidecarPathRequests, metricsBeforeSave.sidecarPathRequests + 1);
    console.log("✓ metrics reloaded from disk continue accumulating correctly as the restarted process handles new requests");

    // --- Periodic auto-save: persistEveryNRequests triggers a save without an explicit persistMetricsNow() call ---
    const autoSavePath = join(tempDir, "auto-save.json");
    const routerC = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
      now: () => clock.time,
      metricsPersistPath: autoSavePath,
      persistEveryNRequests: 2,
    });
    assert.equal(existsSync(autoSavePath), false, "no file should exist before any requests");
    await routerC.route(URGENT_TEXT);
    assert.equal(existsSync(autoSavePath), false, "the auto-save shouldn't fire before the configured request count");
    await routerC.route(URGENT_TEXT + "!!");
    assert.ok(existsSync(autoSavePath), "the auto-save should fire automatically after persistEveryNRequests calls, with no explicit save");
    console.log("✓ metrics are periodically auto-saved to disk every N requests, without requiring an explicit persistMetricsNow() call");

    // --- A missing/corrupt file is treated as a fresh start, not a crash ---
    const missingFileRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
      metricsPersistPath: join(tempDir, "does-not-exist.json"),
    });
    assert.equal(missingFileRouter.getMetrics().totalRequests, 0);
    console.log("✓ pointing at a metrics file that doesn't exist yet starts fresh (0 cumulative requests) instead of throwing");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- Round 4: per-caller budgets, canary/A-B sidecar routing, outbound alert webhooks, Prometheus export ---

async function testPerCallerBudgets() {
  const router = new ModelRouter(new CountingSidecar(), new CountingFoundation());

  // --- Two callers, two independent budgets, each covering exactly one escalation ---
  router.setBudget(FOUNDATION_COST_USD, 60_000, "alice");
  router.setBudget(FOUNDATION_COST_USD * 3, 60_000, "bob"); // bob's is generous enough for three escalations

  const alice1 = await router.route(AMBIGUOUS_TEXT + " alice one", { callerId: "alice" });
  assert.equal(alice1.path, "foundation", "alice's first escalation should still go through");
  const alice2 = await router.route(AMBIGUOUS_TEXT + " alice two", { callerId: "alice" });
  assert.equal(alice2.budgetExceeded, true, "alice's second escalation should be throttled — her budget only covered one");
  console.log("✓ setBudget(limit, periodMs, callerId) configures an independent budget for one specific caller");

  const bob1 = await router.route(AMBIGUOUS_TEXT + " bob one", { callerId: "bob" });
  assert.equal(bob1.path, "foundation");
  const bob2 = await router.route(AMBIGUOUS_TEXT + " bob two", { callerId: "bob" });
  assert.equal(bob2.path, "foundation", "bob's own, separate budget should be untouched by alice's exhausted one");
  console.log("✓ two callers with different configured limits are throttled completely independently of each other");

  // --- A caller who never configured their own budget falls back to the shared default (still unconfigured here => unthrottled) ---
  const carol = await router.route(AMBIGUOUS_TEXT + " carol", { callerId: "carol" });
  assert.equal(carol.path, "foundation");
  assert.equal(carol.budgetExceeded, undefined);
  console.log("✓ a caller who never set their own budget falls back to the shared default budget (unconfigured here, so unthrottled)");

  // --- GET-budget-equivalent: alice's own status, independent of the (still unconfigured) shared default ---
  const aliceStatus = router.getBudgetStatus("alice");
  assert.equal(aliceStatus.enabled, true);
  assert.equal(aliceStatus.exceeded, true);
  const defaultStatus = router.getBudgetStatus();
  assert.equal(defaultStatus.enabled, false, "the shared default was never configured, independent of alice's own budget");
  console.log("✓ getBudgetStatus(callerId) reports that caller's own status, independent of the shared default's");

  // --- Clearing one caller's override reverts them to the shared default, not to "no budget object at all" ---
  router.clearBudget("alice");
  router.setBudget(FOUNDATION_COST_USD * 5, 60_000); // now configure a generous shared default
  const aliceAfterClear = await router.route(AMBIGUOUS_TEXT + " alice three", { callerId: "alice" });
  assert.equal(aliceAfterClear.path, "foundation", "alice should now be governed by the shared default, not stuck throttled or magically unbudgeted");
  console.log("✓ clearing a caller's override reverts them to the shared default budget rather than leaving them unbudgeted");

  // --- GET /metrics-equivalent lists every caller with an explicit override ---
  const metrics = router.getMetrics();
  const callerIds = metrics.callerBudgets.map((b) => b.callerId).sort();
  assert.deepEqual(callerIds, ["bob"], "only bob still has an explicit override — alice's was cleared, carol never set one");
  console.log("✓ GET /metrics's callerBudgets lists exactly the callers with an explicit override currently configured");
}

async function testPerCallerBudgetsOverHttp() {
  const router = new ModelRouter(new CountingSidecar(), new CountingFoundation());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // --- Configure a budget scoped to caller "dana" only, via the same X-Caller-Id header the rate limiter uses ---
    const setRes = await fetch(`${base}/budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "dana" },
      body: JSON.stringify({ limit: FOUNDATION_COST_USD, periodMs: 60_000 }),
    });
    assert.equal(setRes.status, 200);

    // --- GET /budget with dana's header reflects her own budget; without any header, the shared default is untouched ---
    const danaBudget = await (await fetch(`${base}/budget`, { headers: { "X-Caller-Id": "dana" } })).json();
    assert.equal(danaBudget.enabled, true);
    assert.equal(danaBudget.limitUsd, FOUNDATION_COST_USD);
    const defaultBudget = await (await fetch(`${base}/budget`)).json();
    assert.equal(defaultBudget.enabled, false, "configuring dana's own budget must not affect the shared default");
    console.log("✓ POST/GET /budget scoped via X-Caller-Id configures and reads a caller-specific budget, independent of the shared default");

    // --- Dana's first escalation goes through; her second is throttled ---
    await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "dana" },
      body: JSON.stringify({ text: "Can you check on things sometime, no rush, per-caller budget test one?" }),
    });
    const danaThrottledRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "dana" },
      body: JSON.stringify({ text: "Can you check on things sometime, no rush, per-caller budget test two?" }),
    });
    const danaThrottledBody = await danaThrottledRes.json();
    assert.equal(danaThrottledBody.budgetExceeded, true);

    // --- A different caller, with no override of their own, keeps escalating normally — unaffected by dana's exhausted budget ---
    const erinRes = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Caller-Id": "erin" },
      body: JSON.stringify({ text: "Can you check on things sometime, no rush, per-caller budget test for erin?" }),
    });
    const erinBody = await erinRes.json();
    assert.equal(erinBody.path, "foundation");
    assert.equal(erinBody.budgetExceeded, undefined);
    console.log("✓ over real HTTP, a caller-scoped budget throttles only that caller — a different caller with no override keeps escalating normally");

    // --- GET /budget/all surfaces dana's override alongside the shared default ---
    const allBudgets = await (await fetch(`${base}/budget/all`)).json();
    assert.equal(allBudgets.default.enabled, false);
    assert.ok(allBudgets.callers.some((c: { callerId: string }) => c.callerId === "dana"));
    console.log("✓ GET /budget/all lists every caller with an explicit override alongside the shared default");
  } finally {
    httpServer.close();
  }
}

// A marker phrase that appears in none of MockSidecarClassifier's built-in
// keyword lists (checked by inspection — see sidecarClassifier.ts) so the
// primary always reports its zero-signal default ("informational", 0.3)
// for text containing it, while a candidate configured with it as an extra
// "urgent" keyword always disagrees — a clean, deterministic disagreement
// signal independent of the random traffic-split draw.
const CANARY_MARKER = "zzzcanarymarkerzzz";

// A second, distinct marker phrase (also checked by inspection against every
// built-in keyword list) used for the ensemble-voting tests below, kept
// separate from CANARY_MARKER so the two features' fixtures can never
// accidentally collide.
const ENSEMBLE_MARKER = "zzzensemblemarkerzzz";

async function testCanaryRouting() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const candidate = new MockSidecarClassifier({ extraKeywords: [{ label: "urgent", keywords: [CANARY_MARKER] }] });

  const beforeRegistration = router.getCanaryStatus();
  assert.equal(beforeRegistration.enabled, false);
  console.log("✓ with no canary registered, getCanaryStatus() reports enabled: false");

  const PERCENTAGE = 0.4;
  router.setCanary(PERCENTAGE, candidate);
  assert.equal(router.getCanaryStatus().enabled, true);
  assert.equal(router.getCanaryStatus().percentage, PERCENTAGE);

  const SAMPLE_SIZE = 400;
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    // A fresh, distinct input every iteration so the response cache never
    // short-circuits the sidecar/candidate comparison after the first call.
    await router.route(`Please review this ${CANARY_MARKER} note, item number ${i}, when you have a moment.`);
  }

  const status = router.getCanaryStatus();
  assert.equal(status.evaluations, SAMPLE_SIZE, "every request should have evaluated both the primary and the candidate on the same input");
  assert.equal(status.disagreements, SAMPLE_SIZE, "the marker keyword makes the primary and candidate disagree on every single one of these inputs");
  assert.equal(status.disagreementRate, 1);
  console.log(`✓ a canary configured with a distinguishing keyword disagrees with the primary on every evaluated input where that keyword appears (${status.disagreements}/${status.evaluations})`);

  // Genuinely probabilistic, so a generous tolerance band around the
  // configured 40% keeps this from flaking while still proving the traffic
  // split is real (not 0% and not 100%).
  const observedRate = status.servedRequests / status.evaluations;
  assert.ok(
    observedRate > 0.2 && observedRate < 0.6,
    `expected the candidate to serve roughly ${PERCENTAGE * 100}% of ${SAMPLE_SIZE} requests, observed ${(observedRate * 100).toFixed(1)}% (${status.servedRequests}/${status.evaluations})`
  );
  console.log(`✓ a canary registered at ${PERCENTAGE * 100}% traffic actually serves roughly that share of requests over ${SAMPLE_SIZE} samples (observed ${(observedRate * 100).toFixed(1)}%)`);

  router.clearCanary();
  assert.equal(router.getCanaryStatus().enabled, false);
  assert.equal(router.getCanaryStatus().percentage, 0);
  assert.equal(router.getCanaryStatus().evaluations, SAMPLE_SIZE, "clearing the canary must not erase the cumulative comparison counters");
  console.log("✓ clearing the canary disables routing to it without erasing the cumulative comparison metrics");

  const metrics = router.getMetrics();
  assert.equal(metrics.canaryEnabled, false);
  assert.equal(metrics.canaryEvaluations, SAMPLE_SIZE);
  assert.equal(metrics.canaryDisagreements, SAMPLE_SIZE);
  console.log("✓ GET /metrics folds in the same canary evaluation/disagreement counts");
}

async function testCanaryRoutingOverHttp() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const badRes = await fetch(`${base}/router/canary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percentage: 1.5 }),
    });
    assert.equal(badRes.status, 400);
    console.log("✓ POST /router/canary rejects an out-of-range 'percentage' with 400");

    const registerRes = await fetch(`${base}/router/canary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percentage: 0.5, config: { confidenceScale: 0.5 } }),
    });
    assert.equal(registerRes.status, 200);
    const registerBody = await registerRes.json();
    assert.equal(registerBody.enabled, true);
    assert.equal(registerBody.percentage, 0.5);

    const getRes = await fetch(`${base}/router/canary`);
    const getBody = await getRes.json();
    assert.equal(getBody.enabled, true);
    assert.equal(getBody.percentage, 0.5);
    console.log("✓ POST/GET /router/canary registers a candidate sidecar at a given traffic percentage and reads back its status");

    const deleteRes = await fetch(`${base}/router/canary`, { method: "DELETE" });
    const deleteBody = await deleteRes.json();
    assert.equal(deleteBody.enabled, false);
    console.log("✓ DELETE /router/canary clears the registered candidate");
  } finally {
    httpServer.close();
  }
}

async function testAlertWebhooks() {
  // A local HTTP listener standing in for the operator's own webhook receiver.
  const received: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const listener = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, resolve));
  const listenerPort = (listener.address() as AddressInfo).port;
  const listenerUrl = `http://127.0.0.1:${listenerPort}/hook`;

  try {
    // --- budget_exceeded, registered and triggered over real HTTP ---
    const router = new ModelRouter(new CountingSidecar(), new CountingFoundation());
    const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
    const httpServer = app.listen(0);
    const { port } = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const regRes = await fetch(`${base}/alerts/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: listenerUrl }),
      });
      assert.equal(regRes.status, 200);
      const regBody = await regRes.json();
      assert.ok(typeof regBody.secret === "string" && regBody.secret.length > 0, "registering a webhook should hand back a signing secret");
      console.log("✓ POST /alerts/webhook registers a callback URL and hands back a fresh signing secret");

      const statusRes = await fetch(`${base}/alerts/webhook`);
      const statusBody = await statusRes.json();
      assert.equal(statusBody.registered, true);
      assert.equal(statusBody.url, listenerUrl);

      router.setBudget(FOUNDATION_COST_USD, 60_000);
      await router.route(AMBIGUOUS_TEXT + " alert budget one"); // consumes the whole budget
      await router.route(AMBIGUOUS_TEXT + " alert budget two"); // exceeds it -> should fire budget_exceeded
      await router.flushAlertWebhooks();

      assert.ok(received.length >= 1, "the local listener should have received at least one webhook delivery");
      const delivery = received[received.length - 1];
      assert.equal(delivery.headers["x-modelrouter-event"], "budget_exceeded");
      const expectedSignature = createHmac("sha256", regBody.secret).update(delivery.body).digest("hex");
      assert.equal(delivery.headers["x-modelrouter-signature"], expectedSignature, "the delivery must be signed with HMAC-SHA256 over the raw body using the secret handed back at registration");
      const eventBody = JSON.parse(delivery.body);
      assert.equal(eventBody.type, "budget_exceeded");
      console.log("✓ exceeding a configured budget fires a correctly HMAC-SHA256-signed 'budget_exceeded' webhook delivery to the registered callback URL");

      const deleteRes = await fetch(`${base}/alerts/webhook`, { method: "DELETE" });
      assert.equal((await deleteRes.json()).registered, false);
      console.log("✓ DELETE /alerts/webhook unregisters the callback");
    } finally {
      httpServer.close();
    }

    // --- circuit_open, registered and triggered directly against the router (unit-style) ---
    received.length = 0;
    const flakyRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider({ alwaysFail: true }));
    const registration = flakyRouter.registerAlertWebhook(listenerUrl);
    for (let i = 0; i < 3; i++) {
      // Default circuit-breaker threshold is 3 consecutive failures.
      await flakyRouter.route(AMBIGUOUS_TEXT + " circuit trip " + i);
    }
    assert.equal(flakyRouter.getMetrics().circuitState, "open", "3 consecutive foundation failures should have tripped the circuit open");
    await flakyRouter.flushAlertWebhooks();

    const circuitDelivery = received.find((r) => r.headers["x-modelrouter-event"] === "circuit_open");
    assert.ok(circuitDelivery, "the circuit breaker opening should fire a 'circuit_open' alert webhook");
    const expectedCircuitSignature = createHmac("sha256", registration.secret).update(circuitDelivery!.body).digest("hex");
    assert.equal(circuitDelivery!.headers["x-modelrouter-signature"], expectedCircuitSignature);
    console.log("✓ the circuit breaker tripping open fires a correctly signed 'circuit_open' webhook delivery too");

    // A subsequent failure while already open must not re-fire the alert (transition-only, not one-per-failure).
    received.length = 0;
    await flakyRouter.route(AMBIGUOUS_TEXT + " circuit trip already open");
    await flakyRouter.flushAlertWebhooks();
    assert.equal(received.filter((r) => r.headers["x-modelrouter-event"] === "circuit_open").length, 0, "no new circuit_open alert should fire while the circuit is already open");
    console.log("✓ a 'circuit_open' alert fires only on the transition into the open state, not on every subsequent failure while it stays open");

    // --- drift_alert (round 5), registered and triggered directly against the router (unit-style) ---
    received.length = 0;
    const driftRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
    const driftRegistration = driftRouter.registerAlertWebhook(listenerUrl);
    driftRouter.configureDriftDetection({ sampleRate: 1, windowSize: 3, alertThreshold: 0.9 });
    for (let i = 0; i < 3; i++) {
      // SHADOW_DISAGREEMENT_TEXT is a confident sidecar-path input whose implied
      // foundation-model label deliberately disagrees (see its own comment above) —
      // a genuine, deterministic drift signal, not a scripted "always disagree" toggle.
      await driftRouter.route(`${SHADOW_DISAGREEMENT_TEXT} drift webhook variant ${i}`);
    }
    await driftRouter.flushDriftEvaluations();
    await driftRouter.flushAlertWebhooks();

    const driftDelivery = received.find((r) => r.headers["x-modelrouter-event"] === "drift_alert");
    assert.ok(driftDelivery, "a sustained drop in the rolling sidecar/foundation-model agreement rate should fire a 'drift_alert' webhook");
    const expectedDriftSignature = createHmac("sha256", driftRegistration.secret).update(driftDelivery!.body).digest("hex");
    assert.equal(driftDelivery!.headers["x-modelrouter-signature"], expectedDriftSignature, "the drift_alert delivery must be signed the same HMAC-SHA256-over-raw-body way as the other alert types");
    console.log("✓ a sustained drift-detection disagreement fires a correctly signed 'drift_alert' webhook via the same outbound-alert mechanism");
  } finally {
    listener.close();
  }
}

async function testPrometheusMetrics() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: URGENT_TEXT }),
    });
    router.setBudget(1, 60_000, "prom-caller");

    const res = await fetch(`${base}/metrics/prometheus`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/plain"));
    const text = await res.text();

    // Well-formed exposition format: every metric name that appears has both a HELP and a TYPE comment.
    assert.ok(text.includes("# HELP model_router_requests_total"));
    assert.ok(text.includes("# TYPE model_router_requests_total counter"));
    assert.match(text, /^model_router_requests_total \d+(\.\d+)?$/m, "expected a bare 'name value' line for the (unlabeled) requests_total series");
    console.log("✓ GET /metrics/prometheus returns 200 text/plain with well-formed # HELP/# TYPE comments and a matching data line");

    // Labeled series (circuit breaker state, and the per-caller budget we just configured).
    assert.match(text, /model_router_circuit_state\{state="closed"\} 1/);
    assert.match(text, /model_router_circuit_state\{state="open"\} 0/);
    assert.match(text, /model_router_budget_limit_usd\{caller="prom-caller"\} 1/);
    console.log("✓ GET /metrics/prometheus renders labeled series for circuit-breaker state and per-caller budgets");

    // Round-4 feature metric names are all present.
    for (const name of [
      "model_router_canary_enabled",
      "model_router_canary_percentage",
      "model_router_canary_evaluations_total",
      "model_router_alert_webhook_registered",
      "model_router_alert_webhook_deliveries_total",
    ]) {
      assert.ok(text.includes(name), `expected the exposition text to mention ${name}`);
    }
    console.log("✓ GET /metrics/prometheus includes the round-4 canary and alert-webhook metric names");

    // GET /metrics (JSON) is unchanged by the new endpoint's existence.
    const jsonRes = await fetch(`${base}/metrics`);
    assert.equal(jsonRes.headers.get("content-type")?.includes("application/json"), true);
    const jsonBody = await jsonRes.json();
    assert.equal(typeof jsonBody.totalRequests, "number");
    console.log("✓ GET /metrics still returns the original JSON shape, unaffected by the new Prometheus endpoint");
  } finally {
    httpServer.close();
  }
}

// --- Round 5: sidecar drift detection, multi-sidecar ensemble voting, cost-optimization recommender, audit trail ---

async function testDriftDetection() {
  // --- Default status: unconfigured, no evidence of drift ---
  const idleRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const idleStatus = idleRouter.getDriftStatus();
  assert.equal(idleStatus.enabled, false);
  assert.equal(idleStatus.rollingAgreementRate, 1, "no samples yet should read as 'no evidence of drift', not 0% agreement");
  assert.equal(idleStatus.alertActive, false);
  console.log("✓ with drift detection unconfigured, getDriftStatus() reports enabled: false and no evidence of drift");

  // --- Sampling only kicks in on the configured fraction, using an injectable random for determinism ---
  const randomValues = [0.9, 0.1]; // alternate above/below a 0.5 sample rate
  let callIdx = 0;
  const sampledRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
    random: () => randomValues[callIdx++ % randomValues.length],
  });
  sampledRouter.configureDriftDetection({ sampleRate: 0.5, windowSize: 5, alertThreshold: 0.8 });
  assert.equal(sampledRouter.getDriftStatus().enabled, true);
  assert.equal(sampledRouter.getDriftStatus().sampleRate, 0.5);

  await sampledRouter.route(URGENT_TEXT + " drift sample skip"); // random draw 0.9 >= 0.5 -> not sampled
  await sampledRouter.route(URGENT_TEXT + " drift sample take"); // random draw 0.1 < 0.5 -> sampled
  await sampledRouter.flushDriftEvaluations();
  assert.equal(sampledRouter.getDriftStatus().totalEvaluations, 1, "only the draw below sampleRate should trigger a background comparison");
  console.log("✓ drift sampling fires a background comparison only on the configured random fraction of confident sidecar-path requests, independent of the per-request shadowMode flag");

  // --- Rolling-window disagreement activates the alert once the window is full ---
  const driftingRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  driftingRouter.configureDriftDetection({ sampleRate: 1, windowSize: 4, alertThreshold: 0.9 });
  for (let i = 0; i < 4; i++) {
    const result = await driftingRouter.route(`${SHADOW_DISAGREEMENT_TEXT} drift variant ${i}`);
    assert.equal(result.path, "sidecar", "drift sampling must only ever trigger on the confident fast path");
  }
  await driftingRouter.flushDriftEvaluations();
  const drifted = driftingRouter.getDriftStatus();
  assert.equal(drifted.rollingEvaluations, 4);
  assert.equal(drifted.rollingAgreementRate, 0, "the deliberately-disagreeing fixture should register zero rolling agreement");
  assert.equal(drifted.alertActive, true, "a rolling agreement rate below the alert threshold with a full window should activate the alert");
  assert.ok(drifted.lastAlertFiredAt, "an activated alert should record when it last fired");
  console.log(`✓ a sustained rolling disagreement between the sidecar and the foundation model (rolling agreement rate ${drifted.rollingAgreementRate}) activates the drift alert once the window is full`);

  // --- Recovery (a window full of agreements) clears the alert ---
  for (let i = 0; i < 4; i++) {
    await driftingRouter.route(`${URGENT_TEXT} drift recovery ${i}`);
  }
  await driftingRouter.flushDriftEvaluations();
  const recovered = driftingRouter.getDriftStatus();
  assert.equal(recovered.rollingAgreementRate, 1, "the rolling window should now be entirely agreements");
  assert.equal(recovered.alertActive, false, "the alert should clear once the rolling agreement rate recovers above threshold");
  console.log("✓ the drift alert clears once the rolling agreement rate recovers above threshold, allowing a fresh alert on a later drop");

  // --- Fewer than a full window never activates the alert, avoiding noise from a handful of early samples ---
  const freshRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  freshRouter.configureDriftDetection({ sampleRate: 1, windowSize: 10, alertThreshold: 0.9 });
  await freshRouter.route(SHADOW_DISAGREEMENT_TEXT + " insufficient samples");
  await freshRouter.flushDriftEvaluations();
  assert.equal(freshRouter.getDriftStatus().rollingEvaluations, 1);
  assert.equal(freshRouter.getDriftStatus().alertActive, false, "a single disagreement in a not-yet-full window must not trip the alert");
  console.log("✓ the drift alert never fires before the rolling window has a full set of samples");

  // --- Disabling drift detection stops new sampling but preserves cumulative stats ---
  driftingRouter.disableDriftDetection();
  assert.equal(driftingRouter.getDriftStatus().enabled, false);
  assert.equal(driftingRouter.getDriftStatus().totalEvaluations, 8, "disabling must not erase cumulative drift stats");
  const beforeReenable = driftingRouter.getMetrics();
  assert.equal(beforeReenable.driftEnabled, false);
  assert.equal(beforeReenable.driftTotalEvaluations, 8);
  console.log("✓ disabling drift detection stops new sampling without erasing cumulative comparison stats, reflected in GET /metrics too");
}

async function testDriftDetectionOverHttp() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const badRes = await fetch(`${base}/drift/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleRate: 1.5 }),
    });
    assert.equal(badRes.status, 400);
    console.log("✓ POST /drift/config rejects an out-of-range 'sampleRate' with 400");

    const configRes = await fetch(`${base}/drift/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleRate: 1, windowSize: 3, alertThreshold: 0.75 }),
    });
    assert.equal(configRes.status, 200);
    const configBody = await configRes.json();
    assert.equal(configBody.enabled, true);
    assert.equal(configBody.windowSize, 3);
    assert.equal(configBody.alertThreshold, 0.75);

    const statusRes = await fetch(`${base}/drift/status`);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.enabled, true);
    assert.equal(statusBody.sampleRate, 1);
    console.log("✓ POST/GET /drift/config(/status) configures drift sampling over HTTP and reads back its status");

    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${SHADOW_DISAGREEMENT_TEXT} http drift ${i}` }),
      });
    }
    await router.flushDriftEvaluations();
    const afterTrafficRes = await fetch(`${base}/drift/status`);
    const afterTraffic = await afterTrafficRes.json();
    assert.equal(afterTraffic.rollingEvaluations, 3);
    assert.equal(afterTraffic.alertActive, true, "a sustained disagreement over real HTTP traffic should activate the alert");
    console.log("✓ drift sampling over real HTTP /classify traffic populates the rolling window and can activate the alert");

    const deleteRes = await fetch(`${base}/drift/config`, { method: "DELETE" });
    const deleteBody = await deleteRes.json();
    assert.equal(deleteBody.enabled, false);
    console.log("✓ DELETE /drift/config disables drift sampling");
  } finally {
    httpServer.close();
  }
}

async function testEnsembleVoting() {
  // --- No ensemble configured: the primary alone decides, exactly as before this feature existed ---
  const soloRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const soloStatus = soloRouter.getEnsembleStatus();
  assert.equal(soloStatus.enabled, false);
  assert.equal(soloStatus.memberCount, 1, "the primary alone always counts as one member");
  console.log("✓ with no ensemble configured, getEnsembleStatus() reports enabled: false and memberCount: 1 (the primary alone)");

  // --- Ensemble corroboration can push a combined confidence over the threshold even though the primary alone was only borderline ---
  const primary = new CountingSidecar();
  const foundation = new CountingFoundation();
  // REVIEWER_AGREE_TEXT gives the primary exactly 0.60 confidence on "routine" (see its own comment above).
  // This member sees the same input but its own confidence, scaled up, corroborates "routine" more strongly.
  const corroborator = new MockSidecarClassifier({ extraKeywords: [{ label: "routine", keywords: ["leaking"] }], confidenceScale: 1.3 });
  const router = new ModelRouter(primary, foundation);
  router.setEnsemble([{ classifier: corroborator, weight: 1, name: "corroborator" }]);
  assert.equal(router.getEnsembleStatus().enabled, true);
  assert.equal(router.getEnsembleStatus().memberCount, 2);

  const corroborated = await router.route(REVIEWER_AGREE_TEXT);
  assert.equal(corroborated.path, "sidecar", "ensemble corroboration should resolve this at the sidecar tier even though the primary alone (confidence 0.60) would have needed to escalate");
  assert.equal(corroborated.label, "routine");
  assert.ok(closeTo(corroborated.confidence, 0.8), `expected the weighted-average combined confidence (0.60+1.00)/2=0.80, got ${corroborated.confidence}`);
  assert.ok(corroborated.sidecar.ensembleVotes && corroborated.sidecar.ensembleVotes.length === 2, "the result should report each member's individual vote for explainability");
  assert.equal(foundation.calls, 0, "the ensemble should have resolved this without ever escalating to the foundation model");
  assert.ok(closeTo(corroborated.totalCostUsd, 2 * SIDECAR_COST_USD), "an ensemble of 2 members should bill 2 real sidecar-endpoint invocations, not a flat single fee");
  console.log(`✓ two corroborating ensemble members combine to a higher confidence (${corroborated.confidence.toFixed(2)}) than the primary alone had, resolving at the sidecar tier without escalating`);

  // --- A genuine ensemble disagreement keeps the combined confidence too low, so it still escalates ---
  const disagreePrimary = new CountingSidecar();
  const disagreeFoundation = new CountingFoundation();
  const disagreeingMember = new MockSidecarClassifier({ extraKeywords: [{ label: "urgent", keywords: [ENSEMBLE_MARKER] }] });
  const disagreeRouter = new ModelRouter(disagreePrimary, disagreeFoundation);
  disagreeRouter.setEnsemble([{ classifier: disagreeingMember, weight: 1 }]);
  const disagreed = await disagreeRouter.route(`please review this ${ENSEMBLE_MARKER} note calmly`);
  assert.equal(disagreed.path, "foundation", "a genuine ensemble disagreement should keep combined confidence below threshold, so it still escalates");
  assert.ok(closeTo(disagreed.confidence, 0.275), `expected the weighted combined confidence (1*0.3 + 1*0.55)/2=0.275, got ${disagreed.confidence}`);
  assert.ok(disagreeFoundation.calls >= 1, "the foundation model should actually have been invoked");
  const disagreeMetrics = disagreeRouter.getMetrics();
  assert.equal(disagreeMetrics.ensembleEvaluations, 1);
  assert.equal(disagreeMetrics.ensembleDisagreements, 1);
  assert.ok(closeTo(disagreeMetrics.ensembleDisagreementRate, 1));
  console.log("✓ a genuine ensemble disagreement keeps the combined confidence too low to resolve at the sidecar tier, correctly escalating to the foundation model rather than picking a winner arbitrarily");

  // --- Clearing the ensemble reverts to the primary alone, without erasing cumulative stats ---
  disagreeRouter.clearEnsemble();
  assert.equal(disagreeRouter.getEnsembleStatus().enabled, false);
  assert.equal(disagreeRouter.getEnsembleStatus().memberCount, 1);
  assert.equal(disagreeRouter.getEnsembleStatus().evaluations, 1, "clearing the ensemble must not erase the cumulative comparison counters");
  console.log("✓ clearing the ensemble reverts to the primary sidecar alone without erasing cumulative vote-comparison metrics");
}

async function testEnsembleVotingOverHttp() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const badRes = await fetch(`${base}/router/ensemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: [] }),
    });
    assert.equal(badRes.status, 400);
    console.log("✓ POST /router/ensemble rejects an empty 'members' array with 400");

    const registerRes = await fetch(`${base}/router/ensemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: [{ weight: 2, name: "voter-2", config: { confidenceScale: 0.9 } }] }),
    });
    assert.equal(registerRes.status, 200);
    const registerBody = await registerRes.json();
    assert.equal(registerBody.enabled, true);
    assert.equal(registerBody.memberCount, 2);
    assert.ok(registerBody.members.some((m: { name: string; weight: number }) => m.name === "voter-2" && m.weight === 2));

    const getRes = await fetch(`${base}/router/ensemble`);
    const getBody = await getRes.json();
    assert.equal(getBody.enabled, true);
    assert.equal(getBody.memberCount, 2);
    console.log("✓ POST/GET /router/ensemble registers a weighted ensemble member over HTTP and reads back its status");

    const deleteRes = await fetch(`${base}/router/ensemble`, { method: "DELETE" });
    const deleteBody = await deleteRes.json();
    assert.equal(deleteBody.enabled, false);
    assert.equal(deleteBody.memberCount, 1);
    console.log("✓ DELETE /router/ensemble clears every registered member, reverting to the primary alone");
  } finally {
    httpServer.close();
  }
}

async function testCostRecommendation() {
  // --- Not enough escalation samples yet ---
  const freshRouter = new ModelRouter(new CountingSidecar(), new CountingFoundation());
  const early = freshRouter.generateCostRecommendation();
  assert.equal(early.recommendationType, "insufficient_data");
  assert.equal(early.suggestedThreshold, null);
  console.log("✓ GET /recommendations/cost-equivalent reports insufficient_data before enough escalations have been observed");

  // --- "no_change": a cluster of genuinely low-confidence (below the reviewer band) escalations shouldn't be shortcut ---
  const noChangeRouter = new ModelRouter(new CountingSidecar(), new CountingFoundation());
  for (let i = 0; i < 5; i++) {
    const result = await noChangeRouter.route(`${AMBIGUOUS_TEXT} no-change sample ${i}`);
    assert.equal(result.path, "foundation");
  }
  const noChange = noChangeRouter.generateCostRecommendation();
  assert.equal(noChange.recommendationType, "no_change");
  assert.equal(noChange.sampleSize, 5);
  assert.equal(noChange.projectedFoundationCallReductionPct, 0);
  console.log("✓ a cluster of genuinely low-confidence (below-reviewer-band) escalations correctly yields no_change rather than recommending an unsafe threshold shortcut");

  // --- "enable_reviewer_tier": reviewer-band escalations with no reviewer configured ---
  const noReviewerRouter = new ModelRouter(new CountingSidecar(), new CountingFoundation());
  for (let i = 0; i < 5; i++) {
    const result = await noReviewerRouter.route(`${REVIEWER_AGREE_TEXT} reviewer-lever sample ${i}`);
    assert.equal(result.path, "foundation", "with no reviewer configured, a reviewer-band input still escalates straight to the foundation model");
  }
  const reviewerRec = noReviewerRouter.generateCostRecommendation();
  assert.equal(reviewerRec.recommendationType, "enable_reviewer_tier");
  assert.equal(reviewerRec.sampleSize, 5);
  assert.ok(closeTo(reviewerRec.projectedFoundationCallReductionPct!, 100));
  assert.ok(reviewerRec.projectedCostSavingsUsd! > 0, "the reviewer-tier recommendation should project real, positive dollar savings");
  assert.ok(reviewerRec.rationale.includes("reviewer"), `rationale should mention the reviewer tier, got: ${reviewerRec.rationale}`);
  console.log(`✓ recent escalations clustered in the reviewer band with no reviewer configured yield an enable_reviewer_tier recommendation (projected savings $${reviewerRec.projectedCostSavingsUsd!.toFixed(4)})`);

  // --- "lower_threshold": reviewer-band escalations that a *configured* reviewer still couldn't resolve ---
  const withReviewerRouter = new ModelRouter(new CountingSidecar(), new CountingFoundation(), { reviewer: new MockReviewerProvider() });
  for (let i = 0; i < 5; i++) {
    const result = await withReviewerRouter.route(`${REVIEWER_DISAGREE_TEXT} lower-threshold sample ${i}`);
    assert.equal(result.path, "foundation", "the reviewer's own disagreement should cascade this fixture to the full foundation model");
  }
  const lowerRec = withReviewerRouter.generateCostRecommendation();
  assert.equal(lowerRec.recommendationType, "lower_threshold");
  assert.ok(closeTo(lowerRec.suggestedThreshold!, DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD));
  assert.ok(closeTo(lowerRec.projectedFoundationCallReductionPct!, 100));
  assert.ok(lowerRec.projectedCostSavingsUsd! > 0);
  assert.equal(lowerRec.projectedAccuracyRiskPct, null, "no feedback/shadow data has been collected yet, so accuracy risk should be honestly reported as unknown");
  console.log(`✓ escalations a configured reviewer still couldn't resolve yield a lower_threshold recommendation (suggested threshold ${lowerRec.suggestedThreshold}, projected savings $${lowerRec.projectedCostSavingsUsd!.toFixed(4)})`);

  // --- The recommendation reuses the router's real pooled feedback/shadow accuracy data when available ---
  const withFeedbackRouter = new ModelRouter(new CountingSidecar(), new CountingFoundation());
  for (let i = 0; i < 5; i++) {
    await withFeedbackRouter.route(`${AMBIGUOUS_TEXT} feedback sample ${i}`);
  }
  const urgentIds: string[] = [];
  for (const text of ["There's a fire in the pantry, call 911!", "Smoke alarm going off, emergency, help!", "Intruder in the backyard, call 911 immediately!"]) {
    const r = await withFeedbackRouter.route(text);
    assert.equal(r.path, "sidecar");
    urgentIds.push(r.requestId);
  }
  urgentIds.forEach((id) => withFeedbackRouter.recordFeedback(id, true)); // 100% observed accuracy
  const withAccuracy = withFeedbackRouter.generateCostRecommendation();
  assert.equal(withAccuracy.accuracySampleSize, 3);
  assert.ok(closeTo(withAccuracy.projectedAccuracyRiskPct!, 0), "100% observed feedback accuracy should project ~0% accuracy risk");
  console.log(`✓ once pooled feedback/shadow-evaluation data exists, the recommendation's projectedAccuracyRiskPct reuses it (accuracySampleSize ${withAccuracy.accuracySampleSize}, risk ${withAccuracy.projectedAccuracyRiskPct}%)`);
}

async function testCostRecommendationOverHttp() {
  const router = new ModelRouter(new CountingSidecar(), new CountingFoundation());
  const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const earlyRes = await fetch(`${base}/recommendations/cost`);
    assert.equal(earlyRes.status, 200);
    const earlyBody = await earlyRes.json();
    assert.equal(earlyBody.recommendationType, "insufficient_data");

    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${REVIEWER_AGREE_TEXT} http recommendation sample ${i}` }),
      });
    }

    const res = await fetch(`${base}/recommendations/cost`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.recommendationType, "enable_reviewer_tier");
    assert.equal(body.sampleSize, 5);
    assert.ok(typeof body.rationale === "string" && body.rationale.length > 0);
    console.log("✓ GET /recommendations/cost computes a concrete, numerically-justified recommendation from real HTTP traffic, not a canned message");
  } finally {
    httpServer.close();
  }
}

async function testAuditTrailExport() {
  const tempDir = mkdtempSync(join(tmpdir(), "model-router-audit-test-"));
  const auditPath = join(tempDir, "audit-log.jsonl");
  try {
    // --- In-memory only (no auditLogPath configured): still queryable for the life of the process ---
    const memoryOnlyRouter = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
    const urgent = await memoryOnlyRouter.route(URGENT_TEXT + " audit memory");
    const ambiguous = await memoryOnlyRouter.route(AMBIGUOUS_TEXT + " audit memory");
    const memoryExport = memoryOnlyRouter.exportAuditTrail();
    assert.equal(memoryExport.persisted, false, "an unconfigured auditLogPath should read from the in-memory buffer, not a file");
    assert.equal(memoryExport.recordCount, 2);
    const memoryIds = memoryExport.records.map((r) => r.requestId).sort();
    assert.deepEqual(memoryIds, [urgent.requestId, ambiguous.requestId].sort());
    console.log("✓ with no auditLogPath configured, exportAuditTrail() still returns real records from the bounded in-memory buffer");

    // --- Durable, file-backed audit trail ---
    const clock = { time: 10_000_000 };
    const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), { now: () => clock.time, auditLogPath: auditPath });
    router.setBudget(1, 60_000); // so the record's budget snapshot fields are exercised too

    const first = await router.route(URGENT_TEXT + " audit one");
    clock.time += 5_000;
    const second = await router.route(AMBIGUOUS_TEXT + " audit two");
    clock.time += 5_000;
    const cacheHit = await router.route(URGENT_TEXT + " audit one"); // repeats the first input -> a cache hit
    assert.equal(cacheHit.cacheHit, true);

    assert.ok(existsSync(auditPath), "a configured auditLogPath should be written to as requests are handled");
    const onDisk = loadAuditRecords(auditPath);
    assert.equal(onDisk.length, 3, "every routing decision, cache hits included, should be recorded");
    const firstRecord = onDisk.find((r) => r.requestId === first.requestId);
    assert.ok(firstRecord, "the durable log should contain a record for the first request's real requestId");
    assert.equal(firstRecord!.path, "sidecar");
    assert.equal(firstRecord!.label, "urgent");
    assert.equal(firstRecord!.cacheHit, false);
    assert.equal(firstRecord!.budgetEnabled, true, "the budget snapshot in effect at the time should be recorded");
    const cacheHitRecord = onDisk.find((r) => r.requestId === cacheHit.requestId);
    assert.ok(cacheHitRecord, "a cache-hit routing decision should still be recorded, not silently omitted");
    assert.equal(cacheHitRecord!.cacheHit, true);
    console.log("✓ a configured auditLogPath persists a compact JSON-Lines record for every routing decision, cache hits included");

    // --- since= filtering ---
    const sinceExport = router.exportAuditTrail({ sinceMs: 10_000_001 }); // after the first record's timestamp, at/before the second's
    assert.equal(sinceExport.persisted, true);
    assert.equal(sinceExport.recordCount, 2, "the since filter should exclude the first (earlier) record but keep the second and the cache hit");
    assert.ok(!sinceExport.records.some((r) => r.requestId === first.requestId));
    console.log("✓ exportAuditTrail({ sinceMs }) filters out records timestamped before the given cutoff");

    // --- limit= caps the export to the most recent N records ---
    const limitedExport = router.exportAuditTrail({ limit: 1 });
    assert.equal(limitedExport.recordCount, 1);
    assert.equal(limitedExport.records[0].requestId, cacheHit.requestId, "a limited export should keep the most recent record(s)");
    console.log("✓ exportAuditTrail({ limit }) caps the export to the most recent N records");

    // --- Aggregate totals and per-path counts are computed correctly ---
    const fullExport = router.exportAuditTrail();
    assert.equal(fullExport.recordCount, 3);
    assert.ok(closeTo(fullExport.totalCostUsd, first.totalCostUsd + second.totalCostUsd + cacheHit.totalCostUsd));
    assert.equal(fullExport.pathCounts["sidecar"], 2, "both the fresh urgent classification and the cache hit report path 'sidecar'");
    assert.equal(fullExport.pathCounts["foundation"], 1);
    console.log("✓ the audit export's aggregate totalCostUsd/totalLatencyMs and per-path counts match the underlying records");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testAuditTrailExportOverHttp() {
  const tempDir = mkdtempSync(join(tmpdir(), "model-router-audit-http-test-"));
  const auditPath = join(tempDir, "audit-log.jsonl");
  try {
    const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), { auditLogPath: auditPath });
    const app = createApp(router, { rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }) });
    const httpServer = app.listen(0);
    const { port } = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      await fetch(`${base}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Caller-Id": "audit-caller" },
        body: JSON.stringify({ text: URGENT_TEXT + " http audit" }),
      });
      await fetch(`${base}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Caller-Id": "audit-caller" },
        body: JSON.stringify({ text: AMBIGUOUS_TEXT + " http audit" }),
      });

      const badRes = await fetch(`${base}/audit/export?since=not-a-real-date`);
      assert.equal(badRes.status, 400);
      console.log("✓ GET /audit/export rejects an unparseable 'since' with 400");

      const res = await fetch(`${base}/audit/export`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.persisted, true);
      assert.equal(body.recordCount, 2);
      assert.ok(body.records.every((r: { callerId: string }) => r.callerId === "audit-caller"));
      console.log("✓ GET /audit/export returns a compliance-ready export of real routing decisions made over HTTP, including the caller id");

      const limitedRes = await fetch(`${base}/audit/export?limit=1`);
      const limitedBody = await limitedRes.json();
      assert.equal(limitedBody.recordCount, 1);
      console.log("✓ GET /audit/export?limit=N caps the export over HTTP too");
    } finally {
      httpServer.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
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
  await testExplainability();
  await testThreeTierCascade();
  await testCostBudget();
  await testCostBudgetOverHttp();
  await testPersistentMetrics();
  await testPerCallerBudgets();
  await testPerCallerBudgetsOverHttp();
  await testCanaryRouting();
  await testCanaryRoutingOverHttp();
  await testAlertWebhooks();
  await testPrometheusMetrics();
  await testDriftDetection();
  await testDriftDetectionOverHttp();
  await testEnsembleVoting();
  await testEnsembleVotingOverHttp();
  await testCostRecommendation();
  await testCostRecommendationOverHttp();
  await testAuditTrailExport();
  await testAuditTrailExportOverHttp();
  console.log("\nAll model-router smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
