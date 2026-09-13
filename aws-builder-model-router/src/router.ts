import { randomUUID } from "node:crypto";
import type { SidecarClassifier } from "./sidecarClassifier.js";
import type { FoundationModelProvider } from "./foundationModel.js";
import { inferLabelFromFoundationText } from "./foundationModel.js";
import type {
  CircuitState,
  MetricsSnapshot,
  RouteResult,
  SidecarResult,
  CostEstimate,
  FoundationResult,
  CallerBudgetSnapshot,
  CanaryStatus,
  EnsembleStatus,
  EnsembleVoteEntry,
  DriftStatus,
  CostRecommendation,
  AuditRecord,
  AuditExportResult,
} from "./types.js";
import { BudgetTracker, type BudgetStatus } from "./budgetTracker.js";
import { loadMetricsState, saveMetricsState, type PersistedMetricsState } from "./metricsPersistence.js";
import { AlertWebhookDispatcher, type AlertWebhookRegistration, type AlertWebhookStatus } from "./alertWebhooks.js";
import { appendAuditRecord, loadAuditRecords } from "./auditTrail.js";

/** Confidence at/above which the sidecar's own answer is trusted, unless the caller overrides it per request. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Confidence *below* which an escalation skips the reviewer tier entirely and
 * goes straight to the full foundation model. The three-tier cascade's
 * borderline band is therefore `[reviewerConfidenceThreshold, threshold)`:
 * confident enough that a second, cheaper opinion is worth paying for, but
 * not confident enough to trust outright. Below `reviewerConfidenceThreshold`
 * the sidecar has essentially no real signal (e.g. zero keyword hits), and a
 * second small/cheap model is unlikely to do meaningfully better than the
 * first one on a genuinely ambiguous input — so there's no point paying its
 * cost too, and the router pays for the full model's stronger language
 * understanding directly instead. See README's "Three-tier cascade" section
 * for the worked example.
 */
export const DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD = 0.6;

// Simulated, illustrative unit economics — NOT real AWS pricing. They exist
// to make the router's cost/latency tradeoff concrete and demoable without
// live AWS billing data. A real deployment would derive these from
// CloudWatch (endpoint invocation latency) and Cost Explorer / the Bedrock
// and SageMaker pricing pages for the specific instance type / model chosen.
export const SIDECAR_COST_USD = 0.0001; // ~ a small SageMaker real-time endpoint, per invocation
export const SIDECAR_LATENCY_MS = 45;
export const REVIEWER_COST_USD = 0.002; // ~ a smaller/cheaper Bedrock model (e.g. a "lite"/Haiku-class model), per invocation
export const REVIEWER_LATENCY_MS = 250;
export const FOUNDATION_COST_USD = 0.012; // ~ a mid-size Bedrock foundation model call, per invocation
export const FOUNDATION_LATENCY_MS = 850;

// --- Response cache (feature 1) ---
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — plenty for a live demo
const CACHE_MAX_ENTRIES = 1000; // bounded so a long-running demo can't leak memory unboundedly

// --- Circuit breaker (feature 2) ---
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3; // consecutive foundation failures before the circuit opens
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000; // how long the circuit stays open before a half-open trial
/** Simulated wasted latency for a foundation call that failed/timed out before falling back. */
export const FAILED_CALL_FALLBACK_LATENCY_MS = 300;
/** Simulated (near-zero) latency when the circuit is already open and the foundation call is skipped entirely — a "fail fast," not a wasted wait. */
export const OPEN_CIRCUIT_FALLBACK_LATENCY_MS = 5;

// --- Adaptive threshold suggestion (feature 4) ---
const FEEDBACK_LOG_MAX_ENTRIES = 500;
const THRESHOLD_SUGGESTION_MIN_SAMPLES = 3;
const THRESHOLD_SUGGESTION_TARGET_ACCURACY = 0.95;
const THRESHOLD_SUGGESTION_STEP = 0.05;

// --- Persistent metrics (round 3) ---
const DEFAULT_PERSIST_EVERY_N_REQUESTS = 20;

// --- Sidecar drift detection (round 5) ---
/** How many of the most recent drift comparisons the rolling agreement rate is computed over. */
export const DEFAULT_DRIFT_WINDOW_SIZE = 20;
/** Rolling agreement rate below which a `drift_alert` webhook fires (once, on the transition — see `recordDriftSample`). */
export const DEFAULT_DRIFT_ALERT_THRESHOLD = 0.8;

// --- Cost-optimization recommender (round 5) ---
const MIN_ESCALATION_SAMPLES_FOR_RECOMMENDATION = 5;
const ESCALATION_SAMPLES_MAX_ENTRIES = 1000; // bounded ring buffer, same spirit as FEEDBACK_LOG_MAX_ENTRIES
const RECOMMENDATION_THRESHOLD_STEP = 0.05;
const RECOMMENDATION_THRESHOLD_FLOOR = 0.3;

// --- Per-request audit trail (round 5) ---
const DEFAULT_AUDIT_LOG_MAX_IN_MEMORY_RECORDS = 2000;

export interface RouteOptions {
  threshold?: number;
  /**
   * Opt-in shadow evaluation: for a fast-path (sidecar-confident) request,
   * also calls the foundation model in the background — after the response
   * is already on its way back to the caller — purely to log whether it
   * agrees with the sidecar. Never affects the returned result or its
   * latency. See `flushShadowEvaluations()` for waiting on these in tests.
   */
  shadowMode?: boolean;
  /**
   * Identifies which caller this request is on behalf of, for per-caller
   * cost-budget enforcement (round 4) — keyed the same way as the HTTP
   * layer's per-caller rate limiter (`X-Caller-Id`, defaulting to
   * `"anonymous"` when a caller doesn't supply one; see server.ts). A caller
   * with no explicit budget override configured (via `setBudget(limit,
   * periodMs, callerId)`) falls back to the shared default budget, so
   * omitting this entirely (the pre-round-4 call shape) is unchanged: every
   * request is checked against that same shared default, exactly as before.
   */
  callerId?: string;
}

export interface ModelRouterOptions {
  /** How long a cached classification stays valid. Default 5 minutes. */
  cacheTtlMs?: number;
  /** Clock override — mainly for deterministic tests of TTL/circuit-breaker timing. */
  now?: () => number;
  /** Consecutive foundation-model failures before the circuit breaker opens. Default 3. */
  circuitBreakerFailureThreshold?: number;
  /** How long the circuit stays open before allowing a half-open trial call. Default 30s. */
  circuitBreakerCooldownMs?: number;
  /** Router-level default for shadow mode when a request doesn't specify one. Default false. */
  defaultShadowMode?: boolean;
  /**
   * The mid-tier "reviewer" model provider (three-tier cascade). Optional —
   * when omitted, the router behaves exactly like the original two-tier
   * (sidecar / foundation) router: a borderline-confidence request escalates
   * straight to the full foundation model, same as before this feature
   * existed.
   */
  reviewer?: FoundationModelProvider;
  /** Lower bound of the reviewer band — see `DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD`'s doc comment. Ignored when `reviewer` isn't provided. */
  reviewerConfidenceThreshold?: number;
  /** File path to persist cumulative metrics to (feature: persistent metrics). Omit to disable persistence entirely (in-memory only, the original behavior). */
  metricsPersistPath?: string;
  /** Auto-save cadence: persist after this many `route()` calls. Default 20. Ignored when `metricsPersistPath` isn't set. */
  persistEveryNRequests?: number;
  /** Source of randomness for canary/A-B traffic-split decisions (round 4) and drift-detection sampling (round 5). Overridable purely for deterministic tests — production code should never need to set this. Default `Math.random`. */
  random?: () => number;
  /** File path to append per-request audit records to, JSON-Lines-formatted (round 5). Omit to keep the audit trail in-memory only (see `auditLogMaxRecords`) — records are still available via `exportAuditTrail()`/`GET /audit/export` for the life of the process, just not durable across a restart. See `auditTrail.ts`. */
  auditLogPath?: string;
  /** Bound on the in-memory audit-record buffer used when `auditLogPath` isn't set (or as a fast path alongside it). Default 2000 — oldest records are evicted first, the same bounded-log convention as the feedback log and the escalation-sample buffer. */
  auditLogMaxRecords?: number;
}

interface CacheEntry {
  // Every field of RouteResult except requestId/cacheHit, which are assigned fresh on every read.
  result: Omit<RouteResult, "requestId" | "cacheHit">;
  expiresAt: number;
}

interface FeedbackEntry {
  path: RouteResult["path"];
  correct?: boolean;
}

/**
 * Routes classification requests between a cheap/fast "sidecar" model and a
 * slower/pricier foundation model, escalating only when the sidecar isn't
 * confident enough. Framework-agnostic — usable directly as a library, with
 * no dependency on Express or any transport.
 *
 * Beyond the base routing decision, this also implements:
 *   1. A TTL response cache keyed by normalized input + threshold.
 *   2. A circuit breaker around the foundation model with a sidecar-fallback path.
 *   3. Opt-in background shadow evaluation of the foundation model against confident sidecar answers.
 *   4. A feedback log + a simple, illustrative adaptive-threshold suggestion.
 *   5. An optional three-tier cascade: a cheaper/faster "reviewer" model sits
 *      between the sidecar and the full foundation model for borderline
 *      confidence scores.
 *   6. Cost-budget enforcement: once cumulative spend on paid tiers (reviewer
 *      + foundation) hits a configured per-period limit, further escalation
 *      is auto-throttled back to the sidecar's best-effort answer. Scoped
 *      per caller (round 4), with a shared default for callers who never
 *      configure their own.
 *   7. Demo-grade file persistence of cumulative metrics across restarts.
 *   8. Canary/A-B sidecar routing (round 4): a second "candidate" sidecar
 *      classifier can be registered alongside the primary one, with a
 *      configurable share of traffic actually served by its answer instead
 *      — while every request evaluates both, on the same input, purely to
 *      track how often they'd have disagreed.
 *   9. Outbound alert webhooks (round 4): a registered callback URL gets an
 *      HMAC-SHA256-signed POST whenever a cost budget is exceeded or the
 *      circuit breaker opens, so an operator doesn't have to poll `/metrics`.
 */
export class ModelRouter {
  private sidecarPathRequests = 0;
  private reviewerPathRequests = 0;
  private foundationPathRequests = 0;
  private fallbackRequests = 0;
  private budgetThrottledRequests = 0;

  /** Running total of actual (non-cache-hit) spend across every tier a request actually reached. Replaces recomputing cost from path counts × constants, which stopped being accurate once a single request could incur sidecar+reviewer+foundation cost in one go. */
  private cumulativeActualCostUsd = 0;

  private readonly cache = new Map<string, CacheEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly cacheTtlMs: number;

  private readonly now: () => number;

  private circuitState: CircuitState = "closed";
  private consecutiveFoundationFailures = 0;
  private circuitOpenedAt = 0;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;

  private readonly defaultShadowMode: boolean;
  private shadowEvaluations = 0;
  private shadowAgreements = 0;
  private pendingShadowEvaluations: Promise<void>[] = [];

  private readonly feedbackLog = new Map<string, FeedbackEntry>();
  private lastThresholdUsed = DEFAULT_CONFIDENCE_THRESHOLD;

  // --- Three-tier cascade ---
  private readonly reviewerProvider?: FoundationModelProvider;
  private readonly reviewerConfidenceThreshold: number;

  // --- Cost-budget enforcement ---
  /** The shared/default budget — exactly what pre-round-4 `setBudget()`/`getBudgetStatus()`/`clearBudget()` (no `callerId`) operate on, and what any caller lacking their own explicit override falls back to. See `budgetFor()`. */
  private readonly budget: BudgetTracker;
  /** Explicit per-caller overrides (round 4), keyed by the same caller id the HTTP layer identifies callers by (`X-Caller-Id`). A caller not in this map isn't unbudgeted — it shares `this.budget` (the default) instead. */
  private readonly callerBudgets = new Map<string, BudgetTracker>();

  // --- Canary / A-B sidecar routing (round 4) ---
  private candidateSidecar?: SidecarClassifier;
  private canaryPercentage = 0; // 0..1; 0 when no canary is registered
  private canaryEvaluations = 0;
  private canaryDisagreements = 0;
  private canaryServedRequests = 0;
  private readonly random: () => number;

  // --- Outbound alert webhooks (round 4) ---
  private readonly alertWebhooks = new AlertWebhookDispatcher();

  // --- Persistent metrics ---
  private readonly metricsPersistPath?: string;
  private readonly persistEveryNRequests: number;
  private requestsSincePersist = 0;

  // --- Multi-sidecar ensemble voting (round 5) ---
  /** Extra voting members beyond the primary (`this.sidecar`), registered via `setEnsemble()`. Empty means "no ensemble configured" — the primary alone decides, exactly as before this feature existed. */
  private ensembleMembers: { classifier: SidecarClassifier; weight: number; name: string }[] = [];
  private ensemblePrimaryWeight = 1;
  private ensembleEvaluations = 0;
  private ensembleDisagreements = 0;

  // --- Sidecar drift detection (round 5) ---
  private driftSampleRate = 0; // 0 disables drift sampling entirely — opt-in, like the canary and the cost budget
  private driftWindowSize = DEFAULT_DRIFT_WINDOW_SIZE;
  private driftAlertThreshold = DEFAULT_DRIFT_ALERT_THRESHOLD;
  /** Ring buffer of the most recent `driftWindowSize` comparisons (true = agreed), oldest evicted first. */
  private driftWindow: boolean[] = [];
  private driftTotalEvaluations = 0;
  private driftTotalAgreements = 0;
  /** True once the rolling agreement rate has dropped below threshold and an alert has fired for it — cleared the moment it recovers, so a later drop fires a fresh alert rather than staying permanently silent (mirrors the circuit breaker's transition-only alerting). */
  private driftAlertActive = false;
  private lastDriftAlertFiredAt: string | null = null;
  private pendingDriftEvaluations: Promise<void>[] = [];

  // --- Cost-optimization recommender (round 5) ---
  /** Bounded log of every escalated (non-sidecar-path) request's sidecar confidence and the marginal cost that escalation incurred beyond the sidecar's own flat fee — the real traffic data `generateCostRecommendation()` reasons over. Oldest evicted first once over `ESCALATION_SAMPLES_MAX_ENTRIES`. */
  private escalationSamples: { confidence: number; marginalCostUsd: number }[] = [];

  // --- Per-request audit trail (round 5) ---
  private readonly auditLogPath?: string;
  private readonly auditLogMaxRecords: number;
  private auditBuffer: AuditRecord[] = [];

  constructor(
    private readonly sidecar: SidecarClassifier,
    private readonly foundation: FoundationModelProvider,
    options: ModelRouterOptions = {}
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.circuitFailureThreshold = options.circuitBreakerFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this.circuitCooldownMs = options.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
    this.defaultShadowMode = options.defaultShadowMode ?? false;

    this.reviewerProvider = options.reviewer;
    this.reviewerConfidenceThreshold = options.reviewerConfidenceThreshold ?? DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD;

    this.budget = new BudgetTracker(this.now);
    this.random = options.random ?? Math.random;

    this.metricsPersistPath = options.metricsPersistPath;
    this.persistEveryNRequests = options.persistEveryNRequests ?? DEFAULT_PERSIST_EVERY_N_REQUESTS;
    if (this.metricsPersistPath) {
      this.hydrateFromDisk(this.metricsPersistPath);
    }

    this.auditLogPath = options.auditLogPath;
    this.auditLogMaxRecords = options.auditLogMaxRecords ?? DEFAULT_AUDIT_LOG_MAX_IN_MEMORY_RECORDS;
  }

  /**
   * Classifies `input`, always running the sidecar first (unless an
   * unexpired cache entry already answers this exact input+threshold pair).
   *
   * Three-tier cascade (when a `reviewer` provider is configured):
   *   - confidence >= `threshold`                                -> sidecar tier, trusted directly
   *   - `reviewerConfidenceThreshold` <= confidence < `threshold` -> mid tier: the cheaper reviewer
   *     model is consulted; if its guess agrees with the sidecar's label, that resolves the request
   *     (tier "reviewer"); if it disagrees (or the reviewer call itself fails), the router escalates
   *     once more to the full foundation model, exactly as it would have without a reviewer configured
   *   - confidence < `reviewerConfidenceThreshold`                -> top tier directly (skips the
   *     reviewer — see `DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD`'s doc comment for why)
   *
   * Without a `reviewer` configured, this collapses to the original two-tier
   * behavior: anything below `threshold` escalates straight to the full
   * foundation model.
   *
   * Before any paid-tier call (reviewer or foundation), a configured cost
   * budget is checked; once exhausted for the current period, the router
   * auto-throttles and returns the sidecar's best-effort answer instead
   * (`path: "sidecar"`, `budgetExceeded: true`) — see `setBudget()`.
   *
   * If the foundation model is unavailable (simulated failure, or an open
   * circuit breaker) once actually reached, the router falls back to the
   * sidecar's best-effort answer rather than failing the request. Every
   * leg's simulated cost/latency rolls up into the result's totals.
   *
   * `thresholdOrOptions` accepts either a bare number (legacy shorthand for
   * `{ threshold }`) or a full `RouteOptions` object.
   */
  async route(input: string, thresholdOrOptions?: number | RouteOptions): Promise<RouteResult> {
    const options: RouteOptions = typeof thresholdOrOptions === "number" ? { threshold: thresholdOrOptions } : thresholdOrOptions ?? {};
    const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const shadowMode = options.shadowMode ?? this.defaultShadowMode;
    const callerId = options.callerId;
    const budget = this.budgetFor(callerId);
    this.lastThresholdUsed = threshold;

    const now = this.now();
    const cacheKey = `${threshold}::${input.trim().toLowerCase()}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > now) {
        this.cacheHits += 1;
        const result: RouteResult = {
          ...cached.result,
          requestId: randomUUID(),
          cacheHit: true,
          explanation: `${cached.result.explanation} (Served from cache — an identical input and threshold were classified within the last ${Math.round(
            this.cacheTtlMs / 1000
          )}s, so no model was invoked this time.)`,
        };
        this.recordForFeedback(result);
        this.recordAudit(result, callerId, budget);
        this.notePersist();
        return result;
      }
      this.cache.delete(cacheKey); // expired
    }
    this.cacheMisses += 1;

    const { sidecarResult, callCount: sidecarCallCount } = await this.resolveSidecarResult(input);
    const sidecarRecord: SidecarResult & CostEstimate = {
      ...sidecarResult,
      costUsd: SIDECAR_COST_USD * sidecarCallCount,
      latencyMs: SIDECAR_LATENCY_MS,
    };
    const signalDescription = sidecarRecord.ensembleVotes ? this.describeEnsembleVote(sidecarRecord) : this.describeSidecarSignal(sidecarRecord);

    let cacheable: Omit<RouteResult, "requestId" | "cacheHit">;

    if (sidecarResult.confidence >= threshold) {
      this.sidecarPathRequests += 1;
      cacheable = {
        input,
        threshold,
        path: "sidecar",
        label: sidecarResult.label,
        confidence: sidecarResult.confidence,
        explanation: `Sidecar classified this as "${sidecarResult.label}" with confidence ${sidecarResult.confidence.toFixed(
          2
        )} (${signalDescription}), meeting the ${threshold.toFixed(2)} threshold — no escalation needed.`,
        sidecar: sidecarRecord,
        totalCostUsd: sidecarRecord.costUsd,
        totalLatencyMs: sidecarRecord.latencyMs,
      };

      if (shadowMode) {
        // Fire-and-forget: never awaited, so it cannot add latency to (or
        // fail) the response we're about to return.
        this.runShadowEvaluation(input, sidecarResult);
      }
      if (this.driftSampleRate > 0 && this.random() < this.driftSampleRate) {
        // Independent of shadowMode: a router-level *sampled* fraction of all
        // confident traffic, not an opt-in per request — see
        // `runDriftEvaluation()`'s doc comment for how this differs from
        // shadow evaluation despite the similar mechanism.
        this.runDriftEvaluation(input, sidecarResult);
      }
    } else if (budget.isExceeded()) {
      // Auto-throttle: escalation is needed, but the configured cost budget
      // for this period (this caller's own override, or the shared default
      // if they don't have one — see `budgetFor()`) is already exhausted.
      // Stop paying for *any* tier beyond the sidecar and return its
      // best-effort answer instead.
      this.budgetThrottledRequests += 1;
      this.fireBudgetExceededAlert(callerId, budget);
      cacheable = this.buildBudgetCappedResult(input, threshold, sidecarRecord, signalDescription, sidecarRecord.costUsd, sidecarRecord.latencyMs, budget);
    } else if (this.reviewerProvider && sidecarResult.confidence >= this.reviewerConfidenceThreshold) {
      cacheable = await this.runReviewerTier(input, threshold, sidecarResult, sidecarRecord, signalDescription, now, budget, callerId);
    } else {
      cacheable = await this.escalateToFoundation(input, threshold, sidecarResult, sidecarRecord, signalDescription, now, budget, {
        priorCostUsd: sidecarRecord.costUsd,
        priorLatencyMs: sidecarRecord.latencyMs,
      });
    }

    if (cacheable.path === "foundation" || cacheable.path === "fallback") {
      // Cost-optimization recommender (round 5): a real, bounded sample of
      // "what did actually reaching (or attempting) the costly top tier cost
      // beyond the sidecar's own flat fee, and at what sidecar confidence" —
      // see `generateCostRecommendation()`. Deliberately excludes `"reviewer"`-
      // resolved requests: those already found the *cheap* tier working as
      // intended, so they're not the "reduce foundation-model calls" problem
      // this recommender targets.
      this.recordEscalationSample(sidecarResult.confidence, cacheable.totalCostUsd - sidecarRecord.costUsd);
    }

    const result: RouteResult = { ...cacheable, requestId: randomUUID() };
    this.cache.set(cacheKey, { result: cacheable, expiresAt: now + this.cacheTtlMs });
    this.evictOldestCacheEntryIfOverCapacity();
    this.recordForFeedback(result);
    this.recordAudit(result, callerId, budget);
    this.cumulativeActualCostUsd += cacheable.totalCostUsd;
    this.notePersist();
    return result;
  }

  private promptFor(input: string): string {
    return `Classify the urgency of this household message as urgent, routine, or informational, and explain why:\n\n"${input}"`;
  }

  // --- Explainability ---

  /** Human-readable summary of which keyword(s) drove the sidecar's classification, for the `explanation` field. */
  private describeSidecarSignal(sidecarRecord: SidecarResult): string {
    const matches = sidecarRecord.matchedKeywords ?? [];
    if (matches.length === 0) return "no keyword signal matched, so this is a low-confidence default guess";
    return `matched signal(s): ${matches.map((m) => `"${m}"`).join(", ")}`;
  }

  // --- Canary / A-B sidecar routing internals ---

  /**
   * Resolves the sidecar result that the rest of `route()` acts on for this
   * request. With no candidate registered, this is exactly the pre-round-4
   * behavior: the primary's own answer, nothing else. With a candidate
   * registered, *both* are evaluated concurrently on the same input — purely
   * to track agreement (mirroring the spirit of shadow evaluation, but
   * comparing two sidecar configurations against each other instead of
   * sidecar-vs-foundation) — and then one of the two is chosen to actually
   * serve the request, weighted by `canaryPercentage`. Unlike shadow
   * evaluation, this is awaited (not fire-and-forget): the whole point of a
   * *canary* is that its answer can actually reach real traffic, so the
   * comparison has to happen before routing continues, not after the
   * response is already on its way out. Both mock sidecar calls are cheap
   * enough (~45ms simulated, near-instant in practice) that awaiting them
   * concurrently via `Promise.all` doesn't meaningfully add latency.
   *
   * Ensemble voting (round 5, see below) takes priority when configured: if
   * `ensembleMembers` is non-empty, every member (plus the primary) votes on
   * the same input and their combined answer is what the rest of `route()`
   * acts on — canary's traffic-split logic is skipped entirely in that case,
   * since "which single answer wins" and "how do several answers combine
   * into one" are different questions with different traffic-cost profiles
   * (see `EnsembleStatus`'s doc comment in types.ts for exactly how the two
   * features differ). Returns the sidecar-tier call count too, so `route()`
   * can bill `SIDECAR_COST_USD` once per real endpoint invocation this
   * request actually made — 1 for the primary alone or a canary comparison
   * (unchanged pre-round-5 billing), `1 + ensembleMembers.length` for an
   * ensemble vote.
   */
  private async resolveSidecarResult(input: string): Promise<{ sidecarResult: SidecarResult; callCount: number }> {
    if (this.ensembleMembers.length > 0) {
      return { sidecarResult: await this.runEnsembleVote(input), callCount: 1 + this.ensembleMembers.length };
    }

    if (!this.candidateSidecar) {
      return { sidecarResult: await this.sidecar.classify(input), callCount: 1 };
    }

    const [primaryResult, candidateResult] = await Promise.all([this.sidecar.classify(input), this.candidateSidecar.classify(input)]);
    this.canaryEvaluations += 1;
    if (primaryResult.label !== candidateResult.label) {
      this.canaryDisagreements += 1;
    }

    const useCandidate = this.random() < this.canaryPercentage;
    if (useCandidate) this.canaryServedRequests += 1;
    return { sidecarResult: useCandidate ? candidateResult : primaryResult, callCount: 1 };
  }

  /** Registers (or replaces) a candidate sidecar classifier and the traffic share actually served by its answer. `percentage` is a fraction in [0, 1] — 0.3 means "the candidate serves ~30% of requests," not "30 requests." */
  setCanary(percentage: number, candidate: SidecarClassifier): void {
    this.candidateSidecar = candidate;
    this.canaryPercentage = percentage;
  }

  /** Unregisters the candidate sidecar entirely — every request goes back to being evaluated by the primary alone, with no comparison overhead. Cumulative canary counters (evaluations/disagreements/served) are left as-is, matching how `clearBudget()` doesn't erase `budgetThrottledRequests`. */
  clearCanary(): void {
    this.candidateSidecar = undefined;
    this.canaryPercentage = 0;
  }

  /** Current canary configuration and comparison stats. `enabled: false` when no candidate is registered. */
  getCanaryStatus(): CanaryStatus {
    return {
      enabled: this.candidateSidecar !== undefined,
      percentage: this.canaryPercentage,
      evaluations: this.canaryEvaluations,
      disagreements: this.canaryDisagreements,
      disagreementRate: this.canaryEvaluations === 0 ? 0 : this.canaryDisagreements / this.canaryEvaluations,
      servedRequests: this.canaryServedRequests,
      servedRate: this.canaryEvaluations === 0 ? 0 : this.canaryServedRequests / this.canaryEvaluations,
    };
  }

  // --- Multi-sidecar ensemble voting internals (round 5) ---

  /**
   * Registers 1+ additional sidecar classifiers that, together with the
   * primary, *combine* their votes into a single answer for every request —
   * as opposed to canary/A-B routing (above), which *splits* traffic so each
   * request is served by exactly one of two versions. Once configured, every
   * classification runs all `1 + members.length` classifiers concurrently
   * (cheap — the same "sub-millisecond mock, ~45ms simulated" reasoning as
   * canary's own concurrent `Promise.all`) and combines them via a weighted
   * vote (see `runEnsembleVote()`): each member's vote for its own label
   * contributes `weight * confidence` toward that label's score, the label
   * with the highest total score wins, and the combined confidence is that
   * winning score as a fraction of the total weight — so a member that's
   * unsure of its own answer contributes less evidence than one that's
   * confident, not just "one vote regardless of how confident it is."
   *
   * Real deployments would point each member at a genuinely different
   * trained-model endpoint (e.g. three independently-trained classifiers, or
   * the same architecture retrained on different data slices) — here, since
   * every mock is the same keyword-heuristic class, distinctness comes from
   * `SidecarClassifierConfig` the same way canary's candidate does.
   */
  setEnsemble(members: { classifier: SidecarClassifier; weight?: number; name?: string }[], primaryWeight = 1): void {
    this.ensemblePrimaryWeight = primaryWeight;
    this.ensembleMembers = members.map((m, i) => ({ classifier: m.classifier, weight: m.weight ?? 1, name: m.name ?? `member-${i + 1}` }));
  }

  /** Unregisters every ensemble member — the primary alone decides again, with no vote-combination overhead. Cumulative ensemble counters are left as-is, matching `clearCanary()`'s convention. */
  clearEnsemble(): void {
    this.ensembleMembers = [];
    this.ensemblePrimaryWeight = 1;
  }

  /** Current ensemble configuration and cumulative vote-comparison stats. `enabled: false` (and `memberCount: 1`) when no extra members are registered — the primary alone always counts as one member. */
  getEnsembleStatus(): EnsembleStatus {
    const members = [{ name: "primary", weight: this.ensemblePrimaryWeight }, ...this.ensembleMembers.map((m) => ({ name: m.name, weight: m.weight }))];
    return {
      enabled: this.ensembleMembers.length > 0,
      memberCount: members.length,
      members,
      evaluations: this.ensembleEvaluations,
      disagreements: this.ensembleDisagreements,
      disagreementRate: this.ensembleEvaluations === 0 ? 0 : this.ensembleDisagreements / this.ensembleEvaluations,
    };
  }

  /** Runs every registered member (primary + extras) concurrently on the same input and combines their votes via confidence-weighted scoring. Only called when `ensembleMembers.length > 0` — see `resolveSidecarResult()`. */
  private async runEnsembleVote(input: string): Promise<SidecarResult> {
    const members = [{ classifier: this.sidecar, weight: this.ensemblePrimaryWeight, name: "primary" }, ...this.ensembleMembers];
    const results = await Promise.all(members.map((m) => m.classifier.classify(input)));

    const scores = new Map<string, number>();
    const totalWeight = members.reduce((sum, m) => sum + m.weight, 0);
    results.forEach((r, i) => {
      const contribution = members[i].weight * r.confidence;
      scores.set(r.label, (scores.get(r.label) ?? 0) + contribution);
    });

    // Deterministic tie-break: iterate in member order (not Map insertion
    // order alone, since two different labels could tie exactly) and keep
    // the first-seen highest score — with real, varied confidences an exact
    // tie is rare, and this keeps the outcome reproducible when it happens.
    let winnerLabel = results[0].label;
    let winnerScore = -1;
    for (const [label, score] of scores) {
      if (score > winnerScore) {
        winnerScore = score;
        winnerLabel = label;
      }
    }

    const combinedConfidence = totalWeight === 0 ? 0 : Math.min(1, winnerScore / totalWeight);
    const unanimous = results.every((r) => r.label === winnerLabel);
    this.ensembleEvaluations += 1;
    if (!unanimous) this.ensembleDisagreements += 1;

    const ensembleVotes: EnsembleVoteEntry[] = results.map((r, i) => ({ name: members[i].name, label: r.label, confidence: r.confidence, weight: members[i].weight }));
    const matchedKeywords = results.flatMap((r) => r.matchedKeywords ?? []);

    return { label: winnerLabel, confidence: combinedConfidence, matchedKeywords, ensembleVotes };
  }

  /** Human-readable per-member vote breakdown for the `explanation` field, used instead of `describeSidecarSignal()` whenever a result carries `ensembleVotes`. */
  private describeEnsembleVote(sidecarRecord: SidecarResult): string {
    const votes = sidecarRecord.ensembleVotes ?? [];
    const breakdown = votes.map((v) => `${v.name}="${v.label}" (confidence ${v.confidence.toFixed(2)}, weight ${v.weight})`).join(", ");
    return `ensemble vote across ${votes.length} sidecar(s): ${breakdown}`;
  }

  // --- Sidecar drift detection internals (round 5) ---

  /**
   * Configures background drift sampling: on a random `sampleRate` fraction
   * of requests that the sidecar answers confidently enough to resolve on
   * its own (the same trigger point as shadow evaluation), also invoke the
   * foundation model purely to compare labels — but unlike shadow mode
   * (opt-in *per request* via `shadowMode: true`, and reported as an
   * all-time agreement rate with no alerting), this is a router-level,
   * always-on *sampled fraction* of real traffic, tracked over a *rolling*
   * window (the last `windowSize` comparisons, not all-time), with an
   * outbound `drift_alert` webhook when the rolling agreement rate drops
   * below `alertThreshold`. The sampling is deliberately partial — modeling
   * real production model-drift monitoring, where checking every single
   * request against the expensive foundation model would defeat the whole
   * point of having a cheap sidecar in the first place.
   */
  configureDriftDetection(options: { sampleRate: number; windowSize?: number; alertThreshold?: number }): void {
    this.driftSampleRate = options.sampleRate;
    if (options.windowSize !== undefined) {
      this.driftWindowSize = options.windowSize;
      if (this.driftWindow.length > this.driftWindowSize) {
        this.driftWindow = this.driftWindow.slice(this.driftWindow.length - this.driftWindowSize);
      }
    }
    if (options.alertThreshold !== undefined) this.driftAlertThreshold = options.alertThreshold;
  }

  /** Disables drift sampling entirely — no new comparisons are kicked off until reconfigured. Cumulative/rolling counters are left as-is, matching `clearCanary()`'s convention. */
  disableDriftDetection(): void {
    this.driftSampleRate = 0;
  }

  /** Current drift-detection configuration plus rolling and all-time comparison stats. `rollingAgreementRate` is 1 (no evidence of drift) when there are no samples yet, the same "absence of evidence isn't evidence of drift" convention as an unconfigured circuit breaker starting `"closed"`. */
  getDriftStatus(): DriftStatus {
    const rollingEvaluations = this.driftWindow.length;
    const rollingAgreements = this.driftWindow.filter(Boolean).length;
    return {
      enabled: this.driftSampleRate > 0,
      sampleRate: this.driftSampleRate,
      windowSize: this.driftWindowSize,
      alertThreshold: this.driftAlertThreshold,
      rollingEvaluations,
      rollingAgreements,
      rollingAgreementRate: rollingEvaluations === 0 ? 1 : rollingAgreements / rollingEvaluations,
      totalEvaluations: this.driftTotalEvaluations,
      totalAgreements: this.driftTotalAgreements,
      alertActive: this.driftAlertActive,
      lastAlertFiredAt: this.lastDriftAlertFiredAt,
    };
  }

  /** Fire-and-forget background comparison, mirroring `runShadowEvaluation()`'s mechanics exactly (never awaited by `route()`, so it can never add latency to or fail the fast-path response) but feeding the *separate* rolling drift window instead of the all-time shadow counters. */
  private runDriftEvaluation(input: string, sidecarResult: SidecarResult): void {
    const prompt = this.promptFor(input);
    const evaluation = this.foundation
      .invoke(prompt)
      .then((foundationResult) => {
        const impliedLabel = inferLabelFromFoundationText(foundationResult.text);
        this.recordDriftSample(impliedLabel !== null && impliedLabel === sidecarResult.label);
      })
      .catch(() => {
        // A failed comparison call yields no data point this round — same
        // "never surface as an error to the triggering request" handling as
        // shadow evaluation's own failure path.
      });
    this.pendingDriftEvaluations.push(evaluation);
  }

  private recordDriftSample(agreed: boolean): void {
    this.driftTotalEvaluations += 1;
    if (agreed) this.driftTotalAgreements += 1;

    this.driftWindow.push(agreed);
    if (this.driftWindow.length > this.driftWindowSize) this.driftWindow.shift();

    // Require a *full* window before alerting, so a handful of early samples
    // (which could easily be 1/1 or 0/1 by chance) can't trip an alert on
    // noise — the same "decline to react without enough signal" spirit as
    // the adaptive-threshold suggestion's own minimum-sample guard.
    if (this.driftWindow.length < this.driftWindowSize) return;

    const rollingRate = this.driftWindow.filter(Boolean).length / this.driftWindow.length;
    const belowThreshold = rollingRate < this.driftAlertThreshold;

    if (belowThreshold && !this.driftAlertActive) {
      this.driftAlertActive = true;
      this.lastDriftAlertFiredAt = new Date().toISOString();
      this.alertWebhooks.fire("drift_alert", {
        rollingAgreementRate: rollingRate,
        alertThreshold: this.driftAlertThreshold,
        windowSize: this.driftWindow.length,
      });
    } else if (!belowThreshold && this.driftAlertActive) {
      // Recovered — clear the flag so a later drop fires a fresh alert
      // instead of staying permanently silent after the first one.
      this.driftAlertActive = false;
    }
  }

  /** Waits for every drift-detection comparison kicked off so far to settle. Mirrors `flushShadowEvaluations()` for the same reason: drift sampling is fire-and-forget from `route()`'s perspective, so tests (and anything else that wants an up-to-date rolling agreement rate) need this instead of guessing with a sleep. */
  async flushDriftEvaluations(): Promise<void> {
    const pending = this.pendingDriftEvaluations;
    this.pendingDriftEvaluations = [];
    await Promise.all(pending);
  }

  // --- Three-tier cascade internals ---

  private async runReviewerTier(
    input: string,
    threshold: number,
    sidecarResult: SidecarResult,
    sidecarRecord: SidecarResult & CostEstimate,
    signalDescription: string,
    now: number,
    budget: BudgetTracker,
    callerId: string | undefined
  ): Promise<Omit<RouteResult, "requestId" | "cacheHit">> {
    const prompt = this.promptFor(input);
    let reviewerRecord: (FoundationResult & CostEstimate) | undefined;
    let reviewerAgrees = false;
    let reviewerFailed = false;

    try {
      const reviewerAnswer = await this.reviewerProvider!.invoke(prompt);
      reviewerRecord = { ...reviewerAnswer, costUsd: REVIEWER_COST_USD, latencyMs: REVIEWER_LATENCY_MS };
      const reviewerGuess = inferLabelFromFoundationText(reviewerAnswer.text);
      reviewerAgrees = reviewerGuess !== null && reviewerGuess === sidecarResult.label;
    } catch {
      // The reviewer call itself failed (not just "unsure") — fail open to
      // the top tier rather than back to the sidecar, since we already know
      // the sidecar wasn't confident enough on its own. Not billed, same
      // "a failed call isn't charged" convention as the foundation model's
      // own failure path.
      reviewerFailed = true;
    }

    if (!reviewerFailed && reviewerAgrees) {
      // Mid tier resolves it: the cheaper model confirmed the sidecar's label.
      this.reviewerPathRequests += 1;
      budget.record(REVIEWER_COST_USD);
      return {
        input,
        threshold,
        path: "reviewer",
        label: sidecarResult.label,
        confidence: sidecarResult.confidence,
        explanation:
          `Sidecar confidence ${sidecarResult.confidence.toFixed(2)} (${signalDescription}) fell in the reviewer band ` +
          `[${this.reviewerConfidenceThreshold.toFixed(2)}, ${threshold.toFixed(2)}), so the cheaper/faster reviewer model was ` +
          `consulted — it confirmed "${sidecarResult.label}", resolving the request without needing the full foundation model.`,
        sidecar: sidecarRecord,
        reviewer: reviewerRecord,
        totalCostUsd: SIDECAR_COST_USD + REVIEWER_COST_USD,
        totalLatencyMs: SIDECAR_LATENCY_MS + REVIEWER_LATENCY_MS,
      };
    }

    // The reviewer is also unsure (disagreed) or its call failed outright —
    // escalate once more to the full foundation model.
    if (!reviewerFailed) budget.record(REVIEWER_COST_USD);
    const priorCostUsd = SIDECAR_COST_USD + (reviewerFailed ? 0 : REVIEWER_COST_USD);
    const priorLatencyMs = SIDECAR_LATENCY_MS + (reviewerFailed ? 0 : REVIEWER_LATENCY_MS);
    const reviewerNote = reviewerFailed
      ? "the reviewer model call itself failed, so the router escalated straight to the full foundation model"
      : "the reviewer model's own guess did not confirm the sidecar's label, so the router escalated to the full foundation model for a fuller read";

    if (budget.isExceeded()) {
      // The reviewer's own cost (if it ran) just used up the remaining
      // budget — stop here rather than also attempting the foundation call.
      this.budgetThrottledRequests += 1;
      this.fireBudgetExceededAlert(callerId, budget);
      return this.buildBudgetCappedResult(input, threshold, sidecarRecord, signalDescription, priorCostUsd, priorLatencyMs, budget, reviewerRecord, reviewerNote);
    }

    return this.escalateToFoundation(input, threshold, sidecarResult, sidecarRecord, signalDescription, now, budget, {
      priorCostUsd,
      priorLatencyMs,
      reviewerRecord,
      reviewerNote,
    });
  }

  // --- Cost-budget internals ---

  /**
   * Resolves which `BudgetTracker` a given caller's request is checked
   * against (round 4): that caller's own explicit override if they have one,
   * otherwise the shared default — the same tracker pre-round-4 code always
   * used. Calling `route()` with no `callerId` at all (the pre-round-4 call
   * shape) always resolves to the default, so existing callers of this
   * library method see no behavior change.
   */
  private budgetFor(callerId?: string): BudgetTracker {
    if (callerId) {
      const tracker = this.callerBudgets.get(callerId);
      if (tracker) return tracker;
    }
    return this.budget;
  }

  /**
   * Configures (or replaces) a per-period spend cap. See `budgetTracker.ts`
   * for why this is a fixed-window dollar cap. With no `callerId`, this
   * configures the shared default budget (unchanged pre-round-4 behavior —
   * also what any caller lacking their own override falls back to). With a
   * `callerId`, this configures that specific caller's own independent
   * budget instead, tracked and enforced completely separately from every
   * other caller's.
   */
  setBudget(limitUsd: number, periodMs: number, callerId?: string): void {
    if (callerId) {
      let tracker = this.callerBudgets.get(callerId);
      if (!tracker) {
        tracker = new BudgetTracker(this.now);
        this.callerBudgets.set(callerId, tracker);
      }
      tracker.configure(limitUsd, periodMs);
    } else {
      this.budget.configure(limitUsd, periodMs);
    }
  }

  /** Disables budget enforcement for the shared default (no `callerId`), or removes one caller's explicit override — reverting *that caller* to the shared default rather than to "unbudgeted," unless the default itself is also unconfigured. */
  clearBudget(callerId?: string): void {
    if (callerId) {
      this.callerBudgets.delete(callerId);
    } else {
      this.budget.clear();
    }
  }

  /** Current spend vs. limit and time remaining in the period, for the shared default (no `callerId`) or for one specific caller (falls back to the shared default's status if that caller has no explicit override of their own). `enabled: false` when the resolved budget hasn't been configured. */
  getBudgetStatus(callerId?: string): BudgetStatus {
    return this.budgetFor(callerId).status();
  }

  /** Snapshot of every caller with an *explicit* budget override currently configured (for `GET /metrics`/`GET /metrics/prometheus`). Callers relying on the shared default aren't listed — see `getBudgetStatus()`. */
  private listCallerBudgets(): CallerBudgetSnapshot[] {
    return Array.from(this.callerBudgets.entries()).map(([callerId, tracker]) => ({ callerId, ...tracker.status() }));
  }

  /** Fires a `budget_exceeded` alert webhook (a no-op when none is registered — see `alertWebhooks.ts`). Called every time a request is actually throttled, not just on the first transition into "exceeded" — see FRICTION_LOG.md for why that's a deliberate, documented simplification rather than an oversight. */
  private fireBudgetExceededAlert(callerId: string | undefined, budget: BudgetTracker): void {
    const status = budget.status();
    this.alertWebhooks.fire("budget_exceeded", {
      callerId: callerId ?? "anonymous",
      limitUsd: status.limitUsd,
      spendUsd: status.spendUsd,
      periodMs: status.periodMs,
    });
  }

  private buildBudgetCappedResult(
    input: string,
    threshold: number,
    sidecarRecord: SidecarResult & CostEstimate,
    signalDescription: string,
    priorCostUsd: number,
    priorLatencyMs: number,
    budget: BudgetTracker,
    reviewerRecord?: FoundationResult & CostEstimate,
    reviewerNote?: string
  ): Omit<RouteResult, "requestId" | "cacheHit"> {
    const status = budget.status();
    return {
      input,
      threshold,
      path: "sidecar",
      label: sidecarRecord.label,
      confidence: sidecarRecord.confidence,
      explanation:
        `Escalation was needed (sidecar confidence ${sidecarRecord.confidence.toFixed(2)} — ${signalDescription} — below the ` +
        `${threshold.toFixed(2)} threshold)${reviewerNote ? `, and ${reviewerNote}` : ""}, but the configured cost budget ` +
        `($${status.limitUsd?.toFixed(4)} per ${Math.round((status.periodMs ?? 0) / 1000)}s) is exhausted for the current period, so the ` +
        `router auto-throttled and returned the sidecar's best-effort answer instead of paying for another model call.`,
      sidecar: sidecarRecord,
      reviewer: reviewerRecord,
      budgetExceeded: true,
      totalCostUsd: priorCostUsd,
      totalLatencyMs: priorLatencyMs,
    };
  }

  // --- Outbound alert webhooks (round 4) ---

  /** Registers (or replaces) the callback URL that gets an HMAC-SHA256-signed POST whenever a cost budget is exceeded or the circuit breaker opens. Returns the freshly-generated signing secret — hand it back to the caller exactly once, the same convention as `ring-porchpass`'s outbound webhook registration. */
  registerAlertWebhook(url: string): AlertWebhookRegistration {
    return this.alertWebhooks.register(url);
  }

  /** Unregisters the alert webhook — subsequent budget/circuit-breaker events fire no deliveries until a new one is registered. */
  clearAlertWebhook(): void {
    this.alertWebhooks.clear();
  }

  /** Current registration (URL only, never the secret) and delivery history. */
  getAlertWebhookStatus(): AlertWebhookStatus {
    return this.alertWebhooks.getStatus();
  }

  /** Waits for every alert delivery fired so far to settle. Mirrors `flushShadowEvaluations()` — alerts are fire-and-forget from `route()`'s perspective, so tests (and anything else that wants delivery to have actually completed) need this instead of guessing with a sleep. */
  async flushAlertWebhooks(): Promise<void> {
    await this.alertWebhooks.flush();
  }

  // --- Circuit breaker / foundation-escalation internals ---

  private circuitIsOpen(now: number): boolean {
    if (this.circuitState !== "open") return false;
    if (now - this.circuitOpenedAt >= this.circuitCooldownMs) {
      // Cooldown elapsed: allow exactly one trial call through (half-open).
      this.circuitState = "half-open";
      return false;
    }
    return true;
  }

  private onFoundationSuccess(): void {
    this.consecutiveFoundationFailures = 0;
    this.circuitState = "closed";
  }

  private onFoundationFailure(now: number): void {
    this.consecutiveFoundationFailures += 1;
    // A half-open trial failing re-opens the circuit immediately, regardless
    // of the consecutive-failure threshold — the trial existed precisely to
    // test whether the provider had recovered, and it hasn't.
    const wasAlreadyOpen = this.circuitState === "open";
    if (this.circuitState === "half-open" || this.consecutiveFoundationFailures >= this.circuitFailureThreshold) {
      this.circuitState = "open";
      this.circuitOpenedAt = now;
      if (!wasAlreadyOpen) {
        // Fire only on the transition into "open," not on every failure
        // while it's already open — an operator needs to know the breaker
        // just tripped, not get re-alerted on every request it's already
        // fast-failing.
        this.alertWebhooks.fire("circuit_open", {
          consecutiveFailures: this.consecutiveFoundationFailures,
          cooldownMs: this.circuitCooldownMs,
        });
      }
    }
  }

  /** Attempts the full foundation-model call, wrapped in the circuit breaker, given whatever cost/latency has already been incurred by earlier tiers (sidecar alone, or sidecar+reviewer). */
  private async escalateToFoundation(
    input: string,
    threshold: number,
    sidecarResult: SidecarResult,
    sidecarRecord: SidecarResult & CostEstimate,
    signalDescription: string,
    now: number,
    budget: BudgetTracker,
    prior: { priorCostUsd: number; priorLatencyMs: number; reviewerRecord?: FoundationResult & CostEstimate; reviewerNote?: string }
  ): Promise<Omit<RouteResult, "requestId" | "cacheHit">> {
    const prompt = this.promptFor(input);
    const cascadeNote = prior.reviewerNote ? ` (${prior.reviewerNote})` : "";

    if (this.circuitIsOpen(now)) {
      this.fallbackRequests += 1;
      return this.buildFallbackResult(
        input,
        threshold,
        sidecarRecord,
        signalDescription,
        `the circuit breaker is open after repeated foundation-model failures, so the call was skipped${cascadeNote}`,
        OPEN_CIRCUIT_FALLBACK_LATENCY_MS,
        prior.priorCostUsd,
        prior.priorLatencyMs,
        prior.reviewerRecord
      );
    }

    try {
      const foundationResult = await this.foundation.invoke(prompt);
      this.onFoundationSuccess();
      this.foundationPathRequests += 1;
      budget.record(FOUNDATION_COST_USD);
      const foundationRecord = { ...foundationResult, costUsd: FOUNDATION_COST_USD, latencyMs: FOUNDATION_LATENCY_MS };
      return {
        input,
        threshold,
        path: "foundation",
        label: sidecarResult.label,
        confidence: sidecarResult.confidence,
        explanation:
          `Sidecar confidence ${sidecarResult.confidence.toFixed(2)} (${signalDescription}) was below the ${threshold.toFixed(
            2
          )} threshold${cascadeNote}, so the request was escalated to the full foundation model for a fuller answer.`,
        sidecar: sidecarRecord,
        reviewer: prior.reviewerRecord,
        foundation: foundationRecord,
        totalCostUsd: prior.priorCostUsd + FOUNDATION_COST_USD,
        totalLatencyMs: prior.priorLatencyMs + FOUNDATION_LATENCY_MS,
      };
    } catch (err) {
      this.onFoundationFailure(now);
      this.fallbackRequests += 1;
      const reason = err instanceof Error ? err.message : String(err);
      return this.buildFallbackResult(
        input,
        threshold,
        sidecarRecord,
        signalDescription,
        `the foundation model call failed (${reason})${cascadeNote}`,
        FAILED_CALL_FALLBACK_LATENCY_MS,
        prior.priorCostUsd,
        prior.priorLatencyMs,
        prior.reviewerRecord
      );
    }
  }

  private buildFallbackResult(
    input: string,
    threshold: number,
    sidecarRecord: SidecarResult & CostEstimate,
    signalDescription: string,
    reason: string,
    extraLatencyMs: number,
    priorCostUsd: number = SIDECAR_COST_USD,
    priorLatencyMs: number = SIDECAR_LATENCY_MS,
    reviewerRecord?: FoundationResult & CostEstimate
  ): Omit<RouteResult, "requestId" | "cacheHit"> {
    return {
      input,
      threshold,
      path: "fallback",
      label: sidecarRecord.label,
      confidence: sidecarRecord.confidence,
      explanation:
        `Escalation was needed (sidecar confidence ${sidecarRecord.confidence.toFixed(2)} — ${signalDescription} — was below the ${threshold.toFixed(
          2
        )} threshold), but ${reason}. Rather than fail the request, the router fell back to the sidecar's ` +
        `best-effort classification below its normal confidence bar.`,
      sidecar: sidecarRecord,
      reviewer: reviewerRecord,
      fallbackUsed: true,
      totalCostUsd: priorCostUsd,
      totalLatencyMs: priorLatencyMs + extraLatencyMs,
    };
  }

  // --- Response cache internals ---

  private evictOldestCacheEntryIfOverCapacity(): void {
    if (this.cache.size <= CACHE_MAX_ENTRIES) return;
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) this.cache.delete(oldestKey);
  }

  // --- Shadow evaluation internals ---

  private runShadowEvaluation(input: string, sidecarResult: SidecarResult): void {
    const prompt = this.promptFor(input);
    const evaluation = this.foundation
      .invoke(prompt)
      .then((foundationResult) => {
        const impliedLabel = inferLabelFromFoundationText(foundationResult.text);
        this.shadowEvaluations += 1;
        if (impliedLabel !== null && impliedLabel === sidecarResult.label) {
          this.shadowAgreements += 1;
        }
      })
      .catch(() => {
        // A failed shadow call (e.g. the foundation model happens to be
        // "down" in the simulation right now) just means we don't get a
        // comparison data point this time. It must never surface as an
        // error to the caller of the fast-path request that triggered it.
      });
    this.pendingShadowEvaluations.push(evaluation);
  }

  /**
   * Waits for every shadow evaluation kicked off so far to settle. Shadow
   * evaluation is deliberately fire-and-forget in `route()` so it can never
   * add latency to a caller's response — this exists so tests (and any
   * caller that wants an up-to-date `shadowAgreementRate` before reading
   * metrics) can deterministically wait for that background work instead of
   * guessing with a sleep.
   */
  async flushShadowEvaluations(): Promise<void> {
    const pending = this.pendingShadowEvaluations;
    this.pendingShadowEvaluations = [];
    await Promise.all(pending);
  }

  // --- Feedback / adaptive threshold internals ---

  private recordForFeedback(result: RouteResult): void {
    this.feedbackLog.set(result.requestId, { path: result.path });
    if (this.feedbackLog.size > FEEDBACK_LOG_MAX_ENTRIES) {
      const oldestKey = this.feedbackLog.keys().next().value;
      if (oldestKey !== undefined) this.feedbackLog.delete(oldestKey);
    }
  }

  /**
   * Records caller feedback on a past classification, keyed by the
   * `requestId` returned in that classification's `RouteResult`. Returns
   * false if the id isn't known (never issued, or aged out of the bounded
   * feedback log). Feeds `GET /metrics`'s adaptive-threshold suggestion —
   * see `computeThresholdSuggestion()` for exactly how.
   */
  recordFeedback(requestId: string, correct: boolean): boolean {
    const entry = this.feedbackLog.get(requestId);
    if (!entry) return false;
    entry.correct = correct;
    return true;
  }

  /**
   * Illustrative, intentionally simple adaptive-threshold heuristic — NOT
   * real statistical rigor (no confidence intervals, no correction for
   * sample-selection bias, no distinction between "wrong because the sidecar
   * mis-keyworded it" vs. "wrong because the label itself was ambiguous").
   * It pools two proxies for "was the sidecar's trusted (fast-path) answer
   * actually right?":
   *   - explicit caller feedback via `recordFeedback` on fast-path requests, and
   *   - shadow-mode agreement (the foundation model agreeing counts as a
   *     "probably correct" data point, disagreement as "probably wrong").
   * With too few samples it declines to suggest anything rather than react
   * to noise.
   */
  /**
   * Pools the same two "was the sidecar's trusted answer actually right?"
   * proxies `computeThresholdSuggestion()` uses — explicit feedback on
   * fast-path requests, plus shadow-evaluation agreement — into a single
   * accuracy estimate, extracted so the cost-optimization recommender
   * (round 5, `generateCostRecommendation()`) can reuse the *exact* same
   * pooled signal for its own accuracy-risk projection rather than
   * recomputing a second, potentially-diverging notion of "current accuracy."
   * Returns `accuracy: null` when there isn't yet the minimum sample count to
   * trust it — same guard as `computeThresholdSuggestion()`.
   */
  private pooledAccuracyEstimate(): { accuracy: number | null; sampleSize: number } {
    let correct = 0;
    let total = 0;
    for (const entry of this.feedbackLog.values()) {
      if (entry.path === "sidecar" && entry.correct !== undefined) {
        total += 1;
        if (entry.correct) correct += 1;
      }
    }
    correct += this.shadowAgreements;
    total += this.shadowEvaluations;
    if (total < THRESHOLD_SUGGESTION_MIN_SAMPLES) return { accuracy: null, sampleSize: total };
    return { accuracy: correct / total, sampleSize: total };
  }

  private computeThresholdSuggestion(): { suggestedThreshold: number | null; reason: string } {
    const { accuracy, sampleSize: total } = this.pooledAccuracyEstimate();

    if (accuracy === null) {
      return {
        suggestedThreshold: null,
        reason:
          `Not enough feedback/shadow-agreement samples yet (${total}/${THRESHOLD_SUGGESTION_MIN_SAMPLES} minimum) to ` +
          `suggest a threshold change. This heuristic is illustrative, not statistically rigorous.`,
      };
    }

    const currentThresholdPct = this.lastThresholdUsed.toFixed(2);

    if (accuracy < THRESHOLD_SUGGESTION_TARGET_ACCURACY) {
      const suggested = Math.min(0.99, Math.round((this.lastThresholdUsed + THRESHOLD_SUGGESTION_STEP) * 100) / 100);
      return {
        suggestedThreshold: suggested,
        reason:
          `Current threshold ${currentThresholdPct}, but observed sidecar accuracy at that threshold is only ${(accuracy * 100).toFixed(
            1
          )}% over ${total} sample(s) — below the ${(THRESHOLD_SUGGESTION_TARGET_ACCURACY * 100).toFixed(0)}% target. ` +
          `Consider raising the threshold to ${suggested.toFixed(2)}. (Illustrative heuristic, not real statistical rigor — ` +
          `a small or biased sample can easily push this in the wrong direction.)`,
      };
    }

    if (accuracy >= 0.999 && total >= THRESHOLD_SUGGESTION_MIN_SAMPLES * 2 && this.lastThresholdUsed > 0.5) {
      const suggested = Math.max(0.5, Math.round((this.lastThresholdUsed - THRESHOLD_SUGGESTION_STEP) * 100) / 100);
      return {
        suggestedThreshold: suggested,
        reason:
          `Current threshold ${currentThresholdPct}, and observed sidecar accuracy at that threshold is ${(accuracy * 100).toFixed(
            1
          )}% over ${total} sample(s) — consider lowering the threshold to ${suggested.toFixed(2)} to reduce unnecessary ` +
          `foundation-model escalations while remaining reliable. (Illustrative heuristic, not real statistical rigor.)`,
      };
    }

    return {
      suggestedThreshold: null,
      reason: `Current threshold ${currentThresholdPct} looks fine: observed sidecar accuracy is ${(accuracy * 100).toFixed(
        1
      )}% over ${total} sample(s).`,
    };
  }

  // --- Cost-optimization recommender internals (round 5) ---

  /** Records one escalated request's sidecar confidence and marginal cost (beyond the sidecar's own flat fee) into the bounded sample log `generateCostRecommendation()` reasons over. Called from `route()` for every non-sidecar-path result (reviewer/foundation/fallback) — a budget-throttled request is still reported as `path: "sidecar"` and is correctly excluded, since it never actually incurred escalation cost to learn from. */
  private recordEscalationSample(confidence: number, marginalCostUsd: number): void {
    this.escalationSamples.push({ confidence, marginalCostUsd });
    if (this.escalationSamples.length > ESCALATION_SAMPLES_MAX_ENTRIES) this.escalationSamples.shift();
  }

  /**
   * Generates a concrete, numerically-justified cost-optimization suggestion
   * from the router's own accumulated traffic — never a canned message. Two
   * real levers are considered:
   *
   *   1. **Enable the reviewer tier**, checked first when applicable: if no
   *      reviewer is currently configured and some recent escalations sat in
   *      the reviewer band (`[reviewerConfidenceThreshold, threshold)`) —
   *      exactly the confidence range the codebase's own architecture already
   *      considers "not confident enough to trust outright, but worth a
   *      cheaper second opinion before paying for the full model" (see
   *      `DEFAULT_REVIEWER_CONFIDENCE_THRESHOLD`'s doc comment) — recommend
   *      configuring one, with projected savings computed from the real
   *      `REVIEWER_COST_USD` vs. `FOUNDATION_COST_USD` gap on those specific
   *      samples. Preferred over lever 2 for this band because it recovers
   *      cost *without* trusting the sidecar any more than it already is.
   *   2. **Lower the confidence threshold**, otherwise: walks candidate
   *      thresholds downward in `RECOMMENDATION_THRESHOLD_STEP` increments
   *      from the current one, never below `max(RECOMMENDATION_THRESHOLD_FLOOR,
   *      reviewerConfidenceThreshold)` — the router never recommends trusting
   *      the sidecar alone below the confidence band the architecture itself
   *      treats as "essentially no real signal" (same doc comment). For each
   *      candidate, counts how many recent escalations had confidence high
   *      enough to have resolved at the sidecar tier instead, stopping once a
   *      candidate covers a solid majority (>= 50%) of the sample so the
   *      suggestion doesn't chase one outlier down to an unreasonably low
   *      threshold. Projected savings come directly from those *specific*
   *      sampled requests' own already-recorded marginal cost, not a
   *      hypothetical average.
   *
   * Neither lever fires when the recent escalation sample has no headroom at
   * all (every sample already below the reviewer band, or a reviewer is
   * already configured and nothing sits above its own floor) — a `"no_change"`
   * result, matching the honest, conservative spirit of the existing
   * adaptive-threshold suggestion rather than manufacturing a suggestion.
   *
   * Accuracy risk is deliberately *not* independently measured for a
   * lower-confidence band (this demo has no ground-truth labels to draw on)
   * — instead, per the feature's own framing, it reuses the exact same pooled
   * feedback + shadow-evaluation accuracy signal `computeThresholdSuggestion()`
   * already collects (see `pooledAccuracyEstimate()`), honestly presented as
   * an estimate carried over from the current threshold's observed accuracy
   * rather than a directly-measured figure for the *new* one.
   */
  generateCostRecommendation(): CostRecommendation {
    const generatedAt = new Date().toISOString();
    const sampleSize = this.escalationSamples.length;
    const currentThreshold = this.lastThresholdUsed;
    const { accuracy, sampleSize: accuracySampleSize } = this.pooledAccuracyEstimate();
    const projectedAccuracyRiskPct = accuracy === null ? null : (1 - accuracy) * 100;

    if (sampleSize < MIN_ESCALATION_SAMPLES_FOR_RECOMMENDATION) {
      return {
        generatedAt,
        recommendationType: "insufficient_data",
        sampleSize,
        currentThreshold,
        suggestedThreshold: null,
        projectedFoundationCallReductionPct: null,
        projectedCostSavingsUsd: null,
        projectedAccuracyRiskPct: null,
        accuracySampleSize,
        rationale:
          `Only ${sampleSize} escalated request(s) observed so far — at least ${MIN_ESCALATION_SAMPLES_FOR_RECOMMENDATION} are ` +
          `needed before a cost recommendation can be computed from real traffic data rather than guessed.`,
      };
    }

    if (!this.reviewerProvider) {
      const reviewerBandSamples = this.escalationSamples.filter((s) => s.confidence >= this.reviewerConfidenceThreshold && s.confidence < currentThreshold);
      if (reviewerBandSamples.length > 0) {
        const fraction = reviewerBandSamples.length / sampleSize;
        const avgMarginalCost = reviewerBandSamples.reduce((sum, s) => sum + s.marginalCostUsd, 0) / reviewerBandSamples.length;
        const perRequestSavings = Math.max(0, avgMarginalCost - REVIEWER_COST_USD);
        const projectedCostSavingsUsd = perRequestSavings * reviewerBandSamples.length;
        return {
          generatedAt,
          recommendationType: "enable_reviewer_tier",
          sampleSize,
          currentThreshold,
          suggestedThreshold: null,
          projectedFoundationCallReductionPct: fraction * 100,
          projectedCostSavingsUsd,
          projectedAccuracyRiskPct: null,
          accuracySampleSize,
          rationale:
            `${reviewerBandSamples.length} of the last ${sampleSize} escalated request(s) (${(fraction * 100).toFixed(1)}%) had sidecar ` +
            `confidence in the reviewer band [${this.reviewerConfidenceThreshold.toFixed(2)}, ${currentThreshold.toFixed(2)}), but no reviewer ` +
            `model is currently configured, so each one paid full foundation-model cost ($${FOUNDATION_COST_USD.toFixed(4)}) instead of a ` +
            `chance to resolve at the cheaper reviewer tier ($${REVIEWER_COST_USD.toFixed(4)}). Configuring a reviewer (see ` +
            `ModelRouterOptions.reviewer) could save an estimated $${projectedCostSavingsUsd.toFixed(4)} over that sample.`,
        };
      }
    }

    const searchFloor = Math.max(RECOMMENDATION_THRESHOLD_FLOOR, this.reviewerConfidenceThreshold);
    let bestCandidate: number | null = null;
    let bestMovedCount = 0;
    let bestMoveFraction = 0;
    for (
      let candidate = Math.round((currentThreshold - RECOMMENDATION_THRESHOLD_STEP) * 100) / 100;
      candidate >= searchFloor - 1e-9;
      candidate = Math.round((candidate - RECOMMENDATION_THRESHOLD_STEP) * 100) / 100
    ) {
      const moved = this.escalationSamples.filter((s) => s.confidence >= candidate);
      if (moved.length === 0) continue;
      bestCandidate = candidate;
      bestMovedCount = moved.length;
      bestMoveFraction = moved.length / sampleSize;
      if (bestMoveFraction >= 0.5) break; // a solid majority is enough headroom to recommend; stop descending further
    }

    if (bestCandidate !== null) {
      const moved = this.escalationSamples.filter((s) => s.confidence >= bestCandidate!);
      const projectedCostSavingsUsd = moved.reduce((sum, s) => sum + s.marginalCostUsd, 0);
      const accuracyClause =
        accuracy === null
          ? "accuracy risk is unknown — not enough shadow-evaluation/feedback data has been collected yet to estimate it"
          : `an estimated ${projectedAccuracyRiskPct!.toFixed(1)}% accuracy risk, based on ${accuracySampleSize} pooled shadow-evaluation/feedback sample(s) observed at the current threshold`;
      return {
        generatedAt,
        recommendationType: "lower_threshold",
        sampleSize,
        currentThreshold,
        suggestedThreshold: bestCandidate,
        projectedFoundationCallReductionPct: bestMoveFraction * 100,
        projectedCostSavingsUsd,
        projectedAccuracyRiskPct,
        accuracySampleSize,
        rationale:
          `Of the last ${sampleSize} escalated request(s), ${bestMovedCount} (${(bestMoveFraction * 100).toFixed(1)}%) had sidecar ` +
          `confidence >= ${bestCandidate.toFixed(2)}. Lowering the confidence threshold from ${currentThreshold.toFixed(2)} to ` +
          `${bestCandidate.toFixed(2)} would let the sidecar resolve those directly instead of escalating, an estimated ` +
          `$${projectedCostSavingsUsd.toFixed(4)} saved in reviewer/foundation-model spend over that sample, at ${accuracyClause}.`,
      };
    }

    return {
      generatedAt,
      recommendationType: "no_change",
      sampleSize,
      currentThreshold,
      suggestedThreshold: null,
      projectedFoundationCallReductionPct: 0,
      projectedCostSavingsUsd: 0,
      projectedAccuracyRiskPct,
      accuracySampleSize,
      rationale:
        `No cost-reducing change is currently indicated: none of the last ${sampleSize} escalated request(s) had sidecar confidence high ` +
        `enough — above ${searchFloor.toFixed(2)} — for a lower threshold${this.reviewerProvider ? "" : " or the reviewer tier"} to resolve them more cheaply ` +
        `without trusting a confidence band this architecture already treats as too ambiguous to shortcut.`,
    };
  }

  // --- Per-request audit trail internals (round 5) ---

  /**
   * Builds a compact `AuditRecord` for one routing decision and records it —
   * into the bounded in-memory buffer always, and appended to the durable
   * on-disk log too when `auditLogPath` is configured. Reuses
   * `metricsPersistence.ts`'s established file-persistence idioms (see
   * `auditTrail.ts`) rather than a second storage mechanism. Called for
   * every `route()` outcome, cache hits included — a cache hit is still a
   * real routing decision (a compliance reviewer needs to see it was served
   * from cache, not silently omitted from the trail).
   */
  private recordAudit(result: RouteResult, callerId: string | undefined, budget: BudgetTracker): void {
    const budgetStatus = budget.status();
    const record: AuditRecord = {
      requestId: result.requestId,
      timestamp: new Date(this.now()).toISOString(),
      callerId: callerId ?? "anonymous",
      path: result.path,
      label: result.label,
      confidence: result.confidence,
      threshold: result.threshold,
      totalCostUsd: result.totalCostUsd,
      totalLatencyMs: result.totalLatencyMs,
      cacheHit: result.cacheHit ?? false,
      fallbackUsed: result.fallbackUsed ?? false,
      budgetExceeded: result.budgetExceeded ?? false,
      circuitState: this.circuitState,
      budgetEnabled: budgetStatus.enabled,
      budgetLimitUsd: budgetStatus.limitUsd,
      budgetSpendUsd: budgetStatus.spendUsd,
    };

    this.auditBuffer.push(record);
    if (this.auditBuffer.length > this.auditLogMaxRecords) this.auditBuffer.shift();

    if (this.auditLogPath) appendAuditRecord(this.auditLogPath, record);
  }

  /**
   * Produces a compliance/cost-review-ready export of routing decisions,
   * optionally filtered to records at or after `sinceMs` (epoch
   * milliseconds) and/or capped to the most recent `limit` records. Reads
   * from the durable on-disk log when `auditLogPath` is configured (so the
   * export covers the full retained history, restarts included); otherwise
   * falls back to the bounded in-memory buffer (session-only — see
   * `ModelRouterOptions.auditLogMaxRecords`). `persisted` on the result tells
   * a caller which of the two it got.
   */
  exportAuditTrail(options: { sinceMs?: number; limit?: number } = {}): AuditExportResult {
    const source = this.auditLogPath ? loadAuditRecords(this.auditLogPath, options.sinceMs) : this.auditBuffer.filter((r) => options.sinceMs === undefined || Date.parse(r.timestamp) >= options.sinceMs!);
    const records = options.limit !== undefined ? source.slice(Math.max(0, source.length - options.limit)) : source;

    const pathCounts: Record<string, number> = {};
    let totalCostUsd = 0;
    let totalLatencyMs = 0;
    for (const r of records) {
      pathCounts[r.path] = (pathCounts[r.path] ?? 0) + 1;
      totalCostUsd += r.totalCostUsd;
      totalLatencyMs += r.totalLatencyMs;
    }

    return {
      generatedAt: new Date().toISOString(),
      sinceMs: options.sinceMs ?? null,
      persisted: this.auditLogPath !== undefined,
      recordCount: records.length,
      totalCostUsd,
      totalLatencyMs,
      pathCounts,
      records,
    };
  }

  /** Cumulative metrics across every request this router instance has handled. */
  getMetrics(): MetricsSnapshot {
    const totalRequests = this.cacheHits + this.cacheMisses;
    const actualCostUsd = this.cumulativeActualCostUsd;
    const allFoundationCostUsd = totalRequests * FOUNDATION_COST_USD; // hypothetical: every request, including cache hits, always hit the foundation model
    const estimatedSavingsUsd = allFoundationCostUsd - actualCostUsd;
    const { suggestedThreshold, reason } = this.computeThresholdSuggestion();

    let feedbackCount = 0;
    for (const entry of this.feedbackLog.values()) {
      if (entry.correct !== undefined) feedbackCount += 1;
    }

    return {
      totalRequests,
      sidecarPathRequests: this.sidecarPathRequests,
      foundationPathRequests: this.foundationPathRequests,
      sidecarPathRate: totalRequests === 0 ? 0 : this.sidecarPathRequests / totalRequests,
      actualCostUsd,
      allFoundationCostUsd,
      estimatedSavingsUsd,
      estimatedSavingsPct: allFoundationCostUsd === 0 ? 0 : (estimatedSavingsUsd / allFoundationCostUsd) * 100,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRate: totalRequests === 0 ? 0 : this.cacheHits / totalRequests,
      fallbackRequests: this.fallbackRequests,
      circuitState: this.circuitState,
      shadowEvaluations: this.shadowEvaluations,
      shadowAgreements: this.shadowAgreements,
      shadowAgreementRate: this.shadowEvaluations === 0 ? 0 : this.shadowAgreements / this.shadowEvaluations,
      feedbackCount,
      currentThreshold: this.lastThresholdUsed,
      suggestedThreshold,
      thresholdSuggestionReason: reason,
      reviewerPathRequests: this.reviewerPathRequests,
      reviewerPathRate: totalRequests === 0 ? 0 : this.reviewerPathRequests / totalRequests,
      budgetThrottledRequests: this.budgetThrottledRequests,
      callerBudgets: this.listCallerBudgets(),
      canaryEnabled: this.candidateSidecar !== undefined,
      canaryPercentage: this.canaryPercentage,
      canaryEvaluations: this.canaryEvaluations,
      canaryDisagreements: this.canaryDisagreements,
      canaryDisagreementRate: this.canaryEvaluations === 0 ? 0 : this.canaryDisagreements / this.canaryEvaluations,
      canaryServedRequests: this.canaryServedRequests,
      ensembleEnabled: this.ensembleMembers.length > 0,
      ensembleMemberCount: 1 + this.ensembleMembers.length,
      ensembleEvaluations: this.ensembleEvaluations,
      ensembleDisagreements: this.ensembleDisagreements,
      ensembleDisagreementRate: this.ensembleEvaluations === 0 ? 0 : this.ensembleDisagreements / this.ensembleEvaluations,
      driftEnabled: this.driftSampleRate > 0,
      driftSampleRate: this.driftSampleRate,
      driftWindowSize: this.driftWindowSize,
      driftAlertThreshold: this.driftAlertThreshold,
      driftRollingAgreementRate: this.driftWindow.length === 0 ? 1 : this.driftWindow.filter(Boolean).length / this.driftWindow.length,
      driftRollingEvaluations: this.driftWindow.length,
      driftTotalEvaluations: this.driftTotalEvaluations,
      driftTotalAgreements: this.driftTotalAgreements,
      driftAlertActive: this.driftAlertActive,
    };
  }

  /** Resets cumulative metrics (and the cache/circuit-breaker/feedback/budget/canary/ensemble/drift/recommender state) to a fresh start. Mainly useful for tests. Alert-webhook registration and the durable audit-log path/in-memory buffer are left untouched — they're configuration/durable records, not cumulative metrics, the same way the reviewer/foundation providers themselves aren't reset either. */
  resetMetrics(): void {
    this.sidecarPathRequests = 0;
    this.reviewerPathRequests = 0;
    this.foundationPathRequests = 0;
    this.fallbackRequests = 0;
    this.budgetThrottledRequests = 0;
    this.cumulativeActualCostUsd = 0;
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.circuitState = "closed";
    this.consecutiveFoundationFailures = 0;
    this.circuitOpenedAt = 0;
    this.shadowEvaluations = 0;
    this.shadowAgreements = 0;
    this.pendingShadowEvaluations = [];
    this.feedbackLog.clear();
    this.lastThresholdUsed = DEFAULT_CONFIDENCE_THRESHOLD;
    this.budget.clear();
    this.callerBudgets.clear();
    this.candidateSidecar = undefined;
    this.canaryPercentage = 0;
    this.canaryEvaluations = 0;
    this.canaryDisagreements = 0;
    this.canaryServedRequests = 0;
    this.ensembleMembers = [];
    this.ensemblePrimaryWeight = 1;
    this.ensembleEvaluations = 0;
    this.ensembleDisagreements = 0;
    this.driftSampleRate = 0;
    this.driftWindowSize = DEFAULT_DRIFT_WINDOW_SIZE;
    this.driftAlertThreshold = DEFAULT_DRIFT_ALERT_THRESHOLD;
    this.driftWindow = [];
    this.driftTotalEvaluations = 0;
    this.driftTotalAgreements = 0;
    this.driftAlertActive = false;
    this.lastDriftAlertFiredAt = null;
    this.pendingDriftEvaluations = [];
    this.escalationSamples = [];
    this.requestsSincePersist = 0;
  }

  // --- Persistent metrics internals ---

  private hydrateFromDisk(path: string): void {
    const state = loadMetricsState(path);
    if (!state) return; // missing/corrupt file -> start fresh, same as a brand-new router
    this.sidecarPathRequests = state.sidecarPathRequests;
    this.reviewerPathRequests = state.reviewerPathRequests;
    this.foundationPathRequests = state.foundationPathRequests;
    this.fallbackRequests = state.fallbackRequests;
    this.budgetThrottledRequests = state.budgetThrottledRequests;
    this.cacheHits = state.cacheHits;
    this.cacheMisses = state.cacheMisses;
    this.cumulativeActualCostUsd = state.cumulativeActualCostUsd;
    this.circuitState = state.circuitState;
    this.consecutiveFoundationFailures = state.consecutiveFoundationFailures;
    this.circuitOpenedAt = state.circuitOpenedAt;
    this.shadowEvaluations = state.shadowEvaluations;
    this.shadowAgreements = state.shadowAgreements;
    this.lastThresholdUsed = state.lastThresholdUsed;
    this.budget.hydrate(state.budget);
  }

  private exportPersistableState(): Omit<PersistedMetricsState, "version" | "savedAt"> {
    return {
      sidecarPathRequests: this.sidecarPathRequests,
      reviewerPathRequests: this.reviewerPathRequests,
      foundationPathRequests: this.foundationPathRequests,
      fallbackRequests: this.fallbackRequests,
      budgetThrottledRequests: this.budgetThrottledRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cumulativeActualCostUsd: this.cumulativeActualCostUsd,
      circuitState: this.circuitState,
      consecutiveFoundationFailures: this.consecutiveFoundationFailures,
      circuitOpenedAt: this.circuitOpenedAt,
      shadowEvaluations: this.shadowEvaluations,
      shadowAgreements: this.shadowAgreements,
      lastThresholdUsed: this.lastThresholdUsed,
      budget: this.budget.exportState(),
    };
  }

  /** Writes cumulative metrics to `metricsPersistPath` right now. A no-op when persistence isn't configured. Call this on graceful shutdown (e.g. a SIGINT/SIGTERM handler in index.ts) as well as relying on the periodic auto-save. */
  persistMetricsNow(): void {
    if (!this.metricsPersistPath) return;
    saveMetricsState(this.metricsPersistPath, this.exportPersistableState());
  }

  private notePersist(): void {
    if (!this.metricsPersistPath) return;
    this.requestsSincePersist += 1;
    if (this.requestsSincePersist >= this.persistEveryNRequests) {
      this.requestsSincePersist = 0;
      this.persistMetricsNow();
    }
  }
}
