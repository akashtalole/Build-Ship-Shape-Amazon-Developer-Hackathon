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

/** One caller's cost-budget snapshot, as returned in `MetricsSnapshot.callerBudgets` — the status shape from `budgetTracker.ts`'s `BudgetTracker.status()`, tagged with which caller it belongs to. Only callers with an *explicit* per-caller override (set via `setBudget(limit, periodMs, callerId)`) appear here; a caller without one shares the same status as `GET /budget`'s global default instead — see router.ts's `budgetFor()`. */
export interface CallerBudgetSnapshot {
  callerId: string;
  enabled: boolean;
  limitUsd: number | null;
  periodMs: number | null;
  spendUsd: number;
  remainingUsd: number | null;
  exceeded: boolean;
  periodStartedAt: number | null;
  periodEndsAt: number | null;
  msRemainingInPeriod: number | null;
}

/** Canary/A-B sidecar routing status, as returned by `GET /router/canary` and folded into `MetricsSnapshot`. See router.ts's `setCanary()`/`getCanaryStatus()`. */
export interface CanaryStatus {
  enabled: boolean;
  /** Configured fraction (0..1) of requests actually served by the candidate sidecar instead of the primary. 0 when no canary is registered. */
  percentage: number;
  /** Requests where both the primary and candidate sidecar were evaluated on the same input (every non-cache-hit request while a canary is registered). */
  evaluations: number;
  /** Of those evaluations, how many times the candidate's label disagreed with the primary's. */
  disagreements: number;
  /** disagreements / evaluations, 0 when there have been no evaluations yet. */
  disagreementRate: number;
  /** Of those evaluations, how many times the candidate's result was the one actually used to serve the request (per the configured `percentage`). */
  servedRequests: number;
  /** servedRequests / evaluations, 0 when there have been no evaluations yet — the *observed* traffic share, comparable against the *configured* `percentage`. */
  servedRate: number;
}

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

  // --- Per-caller cost budgets (round 4) ---
  /** Snapshot of every caller with an *explicit* budget override currently configured. Callers without one aren't listed — they share `GET /budget`'s global default status instead. */
  callerBudgets: CallerBudgetSnapshot[];

  // --- Canary / A-B sidecar routing (round 4) ---
  canaryEnabled: boolean;
  /** Configured fraction (0..1) of traffic routed to the candidate sidecar. 0 when no canary is registered. */
  canaryPercentage: number;
  canaryEvaluations: number;
  canaryDisagreements: number;
  canaryDisagreementRate: number; // 0 when no canary evaluations yet
  canaryServedRequests: number;
}
