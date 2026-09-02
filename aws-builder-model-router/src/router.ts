import { randomUUID } from "node:crypto";
import type { SidecarClassifier } from "./sidecarClassifier.js";
import type { FoundationModelProvider } from "./foundationModel.js";
import { inferLabelFromFoundationText } from "./foundationModel.js";
import type { CircuitState, MetricsSnapshot, RoutePath, RouteResult, SidecarResult, CostEstimate } from "./types.js";

/** Confidence at/above which the sidecar's own answer is trusted, unless the caller overrides it per request. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

// Simulated, illustrative unit economics — NOT real AWS pricing. They exist
// to make the router's cost/latency tradeoff concrete and demoable without
// live AWS billing data. A real deployment would derive these from
// CloudWatch (endpoint invocation latency) and Cost Explorer / the Bedrock
// and SageMaker pricing pages for the specific instance type / model chosen.
export const SIDECAR_COST_USD = 0.0001; // ~ a small SageMaker real-time endpoint, per invocation
export const SIDECAR_LATENCY_MS = 45;
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
}

interface CacheEntry {
  // Every field of RouteResult except requestId/cacheHit, which are assigned fresh on every read.
  result: Omit<RouteResult, "requestId" | "cacheHit">;
  expiresAt: number;
}

interface FeedbackEntry {
  path: RoutePath;
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
 */
export class ModelRouter {
  private sidecarPathRequests = 0;
  private foundationPathRequests = 0;
  private fallbackRequests = 0;

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
  }

  /**
   * Classifies `input`, always running the sidecar first (unless an
   * unexpired cache entry already answers this exact input+threshold pair).
   * If its confidence meets `threshold`, its answer is returned directly
   * (fast/cheap path). Otherwise the foundation model is invoked for a
   * fuller answer (slow/expensive path) — or, if the foundation model is
   * unavailable (simulated failure, or an open circuit breaker), the router
   * falls back to the sidecar's best-effort answer rather than failing the
   * request. Both calls' simulated cost/latency roll up into the result's
   * totals.
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
          )}s, so neither model was invoked this time.)`,
        };
        this.recordForFeedback(result);
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
        )}, meeting the ${threshold.toFixed(2)} threshold — no escalation needed.`,
        sidecar: sidecarRecord,
        totalCostUsd: SIDECAR_COST_USD,
        totalLatencyMs: SIDECAR_LATENCY_MS,
      };

      if (shadowMode) {
        // Fire-and-forget: never awaited, so it cannot add latency to (or
        // fail) the response we're about to return.
        this.runShadowEvaluation(input, sidecarResult);
      }
    } else {
      const prompt = `Classify the urgency of this household message as urgent, routine, or informational, and explain why:\n\n"${input}"`;

      if (this.circuitIsOpen(now)) {
        this.fallbackRequests += 1;
        cacheable = this.buildFallbackResult(
          input,
          threshold,
          sidecarRecord,
          "the circuit breaker is open after repeated foundation-model failures, so the call was skipped",
          OPEN_CIRCUIT_FALLBACK_LATENCY_MS
        );
      } else {
        try {
          const foundationResult = await this.foundation.invoke(prompt);
          this.onFoundationSuccess();
          this.foundationPathRequests += 1;
          const foundationRecord = {
            ...foundationResult,
            costUsd: FOUNDATION_COST_USD,
            latencyMs: FOUNDATION_LATENCY_MS,
          };
          cacheable = {
            input,
            threshold,
            path: "foundation",
            label: sidecarResult.label,
            confidence: sidecarResult.confidence,
            explanation: `Sidecar confidence ${sidecarResult.confidence.toFixed(2)} was below the ${threshold.toFixed(
              2
            )} threshold, so the request was escalated to the foundation model for a fuller answer.`,
            sidecar: sidecarRecord,
            foundation: foundationRecord,
            totalCostUsd: SIDECAR_COST_USD + FOUNDATION_COST_USD,
            totalLatencyMs: SIDECAR_LATENCY_MS + FOUNDATION_LATENCY_MS,
          };
        } catch (err) {
          this.onFoundationFailure(now);
          this.fallbackRequests += 1;
          const reason = err instanceof Error ? err.message : String(err);
          cacheable = this.buildFallbackResult(
            input,
            threshold,
            sidecarRecord,
            `the foundation model call failed (${reason})`,
            FAILED_CALL_FALLBACK_LATENCY_MS
          );
        }
      }
    }

    const result: RouteResult = { ...cacheable, requestId: randomUUID() };
    this.cache.set(cacheKey, { result: cacheable, expiresAt: now + this.cacheTtlMs });
    this.evictOldestCacheEntryIfOverCapacity();
    this.recordForFeedback(result);
    return result;
  }

  // --- Circuit breaker internals ---

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

  private buildFallbackResult(
    input: string,
    threshold: number,
    sidecarRecord: SidecarResult & CostEstimate,
    reason: string,
    extraLatencyMs: number
  ): Omit<RouteResult, "requestId" | "cacheHit"> {
    return {
      input,
      threshold,
      path: "fallback",
      label: sidecarRecord.label,
      confidence: sidecarRecord.confidence,
      explanation:
        `Escalation was needed (sidecar confidence ${sidecarRecord.confidence.toFixed(2)} was below the ${threshold.toFixed(
          2
        )} threshold), but ${reason}. Rather than fail the request, the router fell back to the sidecar's ` +
        `best-effort classification below its normal confidence bar.`,
      sidecar: sidecarRecord,
      fallbackUsed: true,
      totalCostUsd: SIDECAR_COST_USD,
      totalLatencyMs: SIDECAR_LATENCY_MS + extraLatencyMs,
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
    const prompt = `Classify the urgency of this household message as urgent, routine, or informational, and explain why:\n\n"${input}"`;
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
    const actualCostUsd =
      this.sidecarPathRequests * SIDECAR_COST_USD +
      this.foundationPathRequests * (SIDECAR_COST_USD + FOUNDATION_COST_USD) +
      this.fallbackRequests * SIDECAR_COST_USD; // a failed/skipped foundation call is not billed
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
    };
  }

  /** Resets cumulative metrics (and the cache/circuit-breaker/feedback state) to a fresh start. Mainly useful for tests. */
  resetMetrics(): void {
    this.sidecarPathRequests = 0;
    this.foundationPathRequests = 0;
    this.fallbackRequests = 0;
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
  }
}
