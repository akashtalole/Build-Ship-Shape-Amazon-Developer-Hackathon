/**
 * Smoke test covering both layers of the model router:
 *   1. Direct, unit-style tests against router.ts (no HTTP) — verifying the
 *      sidecar/foundation routing decision and the cumulative metrics math.
 *   2. An end-to-end HTTP test — starts the real Express app on an
 *      ephemeral port and drives it with fetch().
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ModelRouter, SIDECAR_COST_USD, FOUNDATION_COST_USD, DEFAULT_CONFIDENCE_THRESHOLD } from "../src/router.js";
import { MockSidecarClassifier } from "../src/sidecarClassifier.js";
import { MockBedrockProvider } from "../src/foundationModel.js";
import { createApp } from "../src/server.js";

// Fixed inputs chosen so MockSidecarClassifier's keyword heuristics produce
// known, reliable confidence scores:
const URGENT_TEXT = "There's a fire and smoke in the kitchen, please call 911 emergency!"; // 4 urgent-keyword hits -> confidence 0.92
const AMBIGUOUS_TEXT = "Can you check on things when you get a chance?"; // 0 keyword hits in any category -> confidence 0.30
const BORDERLINE_TEXT = "Just a reminder to take out the trash tonight."; // 1 routine-keyword hit ("reminder") -> confidence 0.55

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

async function testHttpEndToEnd() {
  const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
  const app = createApp(router);
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // --- Missing/empty text is rejected ---
  const missingTextRes = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missingTextRes.status, 400);
  const emptyTextRes = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(emptyTextRes.status, 400);
  console.log("✓ POST /classify rejects a missing or empty 'text' field with 400");

  // --- An out-of-range threshold is rejected ---
  const badThresholdRes = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: URGENT_TEXT, threshold: 5 }),
  });
  assert.equal(badThresholdRes.status, 400);
  console.log("✓ POST /classify rejects an out-of-range 'threshold' with 400");

  // --- Fast path over real HTTP ---
  const urgentRes = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: AMBIGUOUS_TEXT }),
  });
  const ambiguousBody = await ambiguousRes.json();
  assert.equal(ambiguousBody.path, "foundation");
  assert.ok(ambiguousBody.foundation?.text);
  console.log("✓ POST /classify escalates to the foundation model over real HTTP for a low-confidence input");

  // --- The same borderline input at the default threshold still escalates ---
  const borderlineDefaultRes = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: BORDERLINE_TEXT }),
  });
  const borderlineDefaultBody = await borderlineDefaultRes.json();
  assert.equal(borderlineDefaultBody.path, "foundation");

  // --- A custom threshold changes routing over real HTTP ---
  const borderlineLowRes = await fetch(`${base}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: BORDERLINE_TEXT, threshold: 0.5 }),
  });
  const borderlineLowBody = await borderlineLowRes.json();
  assert.equal(borderlineLowBody.path, "sidecar");
  console.log("✓ a custom 'threshold' in the request body changes routing behavior for a borderline input");

  // --- Metrics reflect the four successful requests above ---
  const metricsRes = await fetch(`${base}/metrics`);
  assert.equal(metricsRes.status, 200);
  const metrics = await metricsRes.json();
  assert.equal(metrics.totalRequests, 4);
  assert.equal(metrics.sidecarPathRequests, 2);
  assert.equal(metrics.foundationPathRequests, 2);
  console.log("✓ GET /metrics reflects cumulative counts across all prior /classify requests");

  httpServer.close();
}

async function main() {
  await testRouterUnit();
  await testHttpEndToEnd();
  console.log("\nAll model-router smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
