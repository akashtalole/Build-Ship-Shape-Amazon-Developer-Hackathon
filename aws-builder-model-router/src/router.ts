import { randomUUID } from "node:crypto";
import type { SidecarClassifier } from "./sidecarClassifier.js";
import type { FoundationModelProvider } from "./foundationModel.js";
import { inferLabelFromFoundationText } from "./foundationModel.js";
import type { CircuitState, MetricsSnapshot, RouteResult, SidecarResult, CostEstimate, FoundationResult } from "./types.js";
import { BudgetTracker, type BudgetStatus } from "./budgetTracker.js";
import { loadMetricsState, saveMetricsState, type PersistedMetricsState } from "./metricsPersistence.js";

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
 *      is auto-throttled back to the sidecar's best-effort answer.
 *   7. Demo-grade file persistence of cumulative metrics across restarts.
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
  private readonly budget: BudgetTracker;

  // --- Persistent metrics ---
  private readonly metricsPersistPath?: string;
  private readonly persistEveryNRequests: number;
  private requestsSincePersist = 0;

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

    this.metricsPersistPath = options.metricsPersistPath;
    this.persistEveryNRequests = options.persistEveryNRequests ?? DEFAULT_PERSIST_EVERY_N_REQUESTS;
    if (this.metricsPersistPath) {
      this.hydrateFromDisk(this.metricsPersistPath);
    }
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
        this.notePersist();
        return result;
      }
      this.cache.delete(cacheKey); // expired
    }
    this.cacheMisses += 1;

    const sidecarResult = await this.sidecar.classify(input);
    const sidecarRecord: SidecarResult & CostEstimate = {
      ...sidecarResult,
      costUsd: SIDECAR_COST_USD,
      latencyMs: SIDECAR_LATENCY_MS,
    };
    const signalDescription = this.describeSidecarSignal(sidecarRecord);

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
        totalCostUsd: SIDECAR_COST_USD,
        totalLatencyMs: SIDECAR_LATENCY_MS,
      };

      if (shadowMode) {
        // Fire-and-forget: never awaited, so it cannot add latency to (or
        // fail) the response we're about to return.
        this.runShadowEvaluation(input, sidecarResult);
      }
    } else if (this.budget.isExceeded()) {
      // Auto-throttle: escalation is needed, but the configured cost budget
      // for this period is already exhausted. Stop paying for *any* tier
      // beyond the sidecar and return its best-effort answer instead.
      this.budgetThrottledRequests += 1;
      cacheable = this.buildBudgetCappedResult(input, threshold, sidecarRecord, signalDescription, SIDECAR_COST_USD, SIDECAR_LATENCY_MS);
    } else if (this.reviewerProvider && sidecarResult.confidence >= this.reviewerConfidenceThreshold) {
      cacheable = await this.runReviewerTier(input, threshold, sidecarResult, sidecarRecord, signalDescription, now);
    } else {
      cacheable = await this.escalateToFoundation(input, threshold, sidecarResult, sidecarRecord, signalDescription, now, {
        priorCostUsd: SIDECAR_COST_USD,
        priorLatencyMs: SIDECAR_LATENCY_MS,
      });
    }

    const result: RouteResult = { ...cacheable, requestId: randomUUID() };
    this.cache.set(cacheKey, { result: cacheable, expiresAt: now + this.cacheTtlMs });
    this.evictOldestCacheEntryIfOverCapacity();
    this.recordForFeedback(result);
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

  // --- Three-tier cascade internals ---

  private async runReviewerTier(
    input: string,
    threshold: number,
    sidecarResult: SidecarResult,
    sidecarRecord: SidecarResult & CostEstimate,
    signalDescription: string,
    now: number
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
      this.budget.record(REVIEWER_COST_USD);
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
    if (!reviewerFailed) this.budget.record(REVIEWER_COST_USD);
    const priorCostUsd = SIDECAR_COST_USD + (reviewerFailed ? 0 : REVIEWER_COST_USD);
    const priorLatencyMs = SIDECAR_LATENCY_MS + (reviewerFailed ? 0 : REVIEWER_LATENCY_MS);
    const reviewerNote = reviewerFailed
      ? "the reviewer model call itself failed, so the router escalated straight to the full foundation model"
      : "the reviewer model's own guess did not confirm the sidecar's label, so the router escalated to the full foundation model for a fuller read";

    if (this.budget.isExceeded()) {
      // The reviewer's own cost (if it ran) just used up the remaining
      // budget — stop here rather than also attempting the foundation call.
      this.budgetThrottledRequests += 1;
      return this.buildBudgetCappedResult(input, threshold, sidecarRecord, signalDescription, priorCostUsd, priorLatencyMs, reviewerRecord, reviewerNote);
    }

    return this.escalateToFoundation(input, threshold, sidecarResult, sidecarRecord, signalDescription, now, {
      priorCostUsd,
      priorLatencyMs,
      reviewerRecord,
      reviewerNote,
    });
  }

  // --- Cost-budget internals ---

  /** Configures (or replaces) the per-period spend cap. See `budgetTracker.ts` for why this is a fixed-window dollar cap. */
  setBudget(limitUsd: number, periodMs: number): void {
    this.budget.configure(limitUsd, periodMs);
  }

  /** Disables budget enforcement — escalations are never throttled until `setBudget` is called again. */
  clearBudget(): void {
    this.budget.clear();
  }

  /** Current spend vs. limit and time remaining in the period. `enabled: false` when no budget has been configured. */
  getBudgetStatus(): BudgetStatus {
    return this.budget.status();
  }

  private buildBudgetCappedResult(
    input: string,
    threshold: number,
    sidecarRecord: SidecarResult & CostEstimate,
    signalDescription: string,
    priorCostUsd: number,
    priorLatencyMs: number,
    reviewerRecord?: FoundationResult & CostEstimate,
    reviewerNote?: string
  ): Omit<RouteResult, "requestId" | "cacheHit"> {
    const status = this.budget.status();
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
    if (this.circuitState === "half-open" || this.consecutiveFoundationFailures >= this.circuitFailureThreshold) {
      this.circuitState = "open";
      this.circuitOpenedAt = now;
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
      this.budget.record(FOUNDATION_COST_USD);
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
  private computeThresholdSuggestion(): { suggestedThreshold: number | null; reason: string } {
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

    if (total < THRESHOLD_SUGGESTION_MIN_SAMPLES) {
      return {
        suggestedThreshold: null,
        reason:
          `Not enough feedback/shadow-agreement samples yet (${total}/${THRESHOLD_SUGGESTION_MIN_SAMPLES} minimum) to ` +
          `suggest a threshold change. This heuristic is illustrative, not statistically rigorous.`,
      };
    }

    const accuracy = correct / total;
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
    };
  }

  /** Resets cumulative metrics (and the cache/circuit-breaker/feedback/budget state) to a fresh start. Mainly useful for tests. */
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
