/**
 * Shared types for the model-router demo: an urgency classifier for
 * household-automation-style messages (the kind a HomeOps/Alexa+ style
 * assistant, a Ring/Bee style notification pipeline, etc. might need to
 * triage). The pattern itself is task-agnostic — swap the label set and the
 * sidecar's heuristics for any other narrow classification task.
 */

/** The three urgency buckets the demo task classifies messages into. */
export type UrgencyLabel = "urgent" | "routine" | "informational";

/**
 * Which path a given request took through the router.
 *   - "sidecar"    the sidecar's own confident answer, no escalation needed
 *                  (this is also reported for a budget-throttled response —
 *                  see `budgetExceeded` on RouteResult to tell the two apart)
 *   - "reviewer"   escalated to the cheaper/faster mid-tier "reviewer" model,
 *                  which confirmed the sidecar's label and resolved it there
 *   - "foundation" escalated to the full foundation model (either directly,
 *                  because confidence was too low even for the reviewer tier,
 *                  or after the reviewer was *also* unsure) and it answered
 *                  successfully
 *   - "fallback"   escalation was needed but the foundation model was unavailable
 *                  (simulated failure/timeout, or the circuit breaker was open),
 *                  so the sidecar's best-effort answer was used instead — see
 *                  `fallbackUsed` on RouteResult for the human-readable reason.
 */
export type RoutePath = "sidecar" | "reviewer" | "foundation" | "fallback";

/**
 * Result shape returned by a SageMaker-runtime-style classifier endpoint.
 * `matchedKeywords` is optional and specific to `MockSidecarClassifier`'s
 * keyword-heuristic implementation (its explainability story) — a real
 * trained-model endpoint (see that class's doc comment for the swap-in code)
 * would need a different explainability mechanism (e.g. attention weights or
 * SHAP values) and may simply omit this field.
 */
export interface SidecarResult {
  label: string;
  confidence: number; // 0..1
  /** Which keyword(s)/pattern(s) contributed to this classification, in the order they're listed in the matcher's keyword set. Empty when nothing matched. */
  matchedKeywords?: string[];
}

/** Result shape returned by a Bedrock-runtime-style model invocation. */
export interface FoundationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Simulated cost + latency for one call to a given path. Illustrative, not real pricing. */
export interface CostEstimate {
  costUsd: number;
  latencyMs: number;
}

/** Full record of how the router handled a single request. */
export interface RouteResult {
  /** Unique id for this specific route() call, usable as the key for POST /feedback. */
  requestId: string;
  input: string;
  threshold: number;
  path: RoutePath;
  label: string;
  confidence: number;
  explanation: string;
  sidecar: SidecarResult & CostEstimate;
  /** Present only when the mid-tier reviewer model was actually invoked (path "reviewer", or "foundation"/"fallback" reached via the reviewer being unsure). */
  reviewer?: FoundationResult & CostEstimate;
  foundation?: FoundationResult & CostEstimate;
  totalCostUsd: number;
  totalLatencyMs: number;
  /** True when this result was served from the response cache without invoking either model. */
  cacheHit?: boolean;
  /**
   * True when escalation was needed but the foundation model was unavailable
   * (simulated failure/timeout, or an open circuit breaker), so the sidecar's
   * best-effort answer was returned instead of failing the request.
   */
  fallbackUsed?: boolean;
  /**
   * True when escalation was needed but the configured cost budget for the
   * current period was already exhausted, so the router auto-throttled and
   * returned the sidecar's best-effort answer (`path: "sidecar"`) instead of
   * calling any paid model tier. Lets a caller tell this apart from a normal
   * fast-path hit, which never sets this flag.
   */
  budgetExceeded?: boolean;
}

/** State of the router's foundation-model circuit breaker. */
export type CircuitState = "closed" | "open" | "half-open";

/** Cumulative metrics the router tracks across all requests it has handled. */
export interface MetricsSnapshot {
  totalRequests: number;
  sidecarPathRequests: number;
  foundationPathRequests: number;
  sidecarPathRate: number; // sidecarPathRequests / totalRequests, 0 when no requests yet
  actualCostUsd: number;
  allFoundationCostUsd: number; // hypothetical cost if every request always hit the foundation model
  estimatedSavingsUsd: number;
  estimatedSavingsPct: number; // 0..100, 0 when no requests yet

  // --- Response cache (feature 1) ---
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number; // cacheHits / totalRequests, 0 when no requests yet

  // --- Circuit breaker / fallback chain (feature 2) ---
  fallbackRequests: number;
  circuitState: CircuitState;

  // --- Shadow evaluation (feature 3) ---
  shadowEvaluations: number;
  shadowAgreements: number;
  shadowAgreementRate: number; // shadowAgreements / shadowEvaluations, 0 when no shadow evals yet

  // --- Adaptive threshold suggestion (feature 4) ---
  feedbackCount: number;
  currentThreshold: number; // the threshold most recently used by a /classify call
  suggestedThreshold: number | null; // null when there isn't enough signal to suggest a change
  thresholdSuggestionReason: string;

  // --- Three-tier cascade: mid-tier reviewer (round 3) ---
  /** Requests resolved at the mid tier (the cheaper/faster reviewer model confirmed the sidecar's label). */
  reviewerPathRequests: number;
  reviewerPathRate: number; // reviewerPathRequests / totalRequests, 0 when no requests yet

  // --- Cost-budget enforcement (round 3) ---
  /** Requests where escalation was needed but the configured cost budget was already exhausted, so the sidecar's best-effort answer was returned instead (see RouteResult.budgetExceeded). Not counted in sidecarPathRequests. */
  budgetThrottledRequests: number;
}
