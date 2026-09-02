import type { SidecarClassifier } from "./sidecarClassifier.js";
import type { FoundationModelProvider } from "./foundationModel.js";
import type { MetricsSnapshot, RouteResult } from "./types.js";

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

/**
 * Routes classification requests between a cheap/fast "sidecar" model and a
 * slower/pricier foundation model, escalating only when the sidecar isn't
 * confident enough. Framework-agnostic — usable directly as a library, with
 * no dependency on Express or any transport.
 */
export class ModelRouter {
  private sidecarPathRequests = 0;
  private foundationPathRequests = 0;

  constructor(
    private readonly sidecar: SidecarClassifier,
    private readonly foundation: FoundationModelProvider
  ) {}

  /**
   * Classifies `input`, always running the sidecar first. If its confidence
   * meets `threshold`, its answer is returned directly (fast/cheap path).
   * Otherwise the foundation model is invoked for a fuller answer
   * (slow/expensive path), and both calls' simulated cost/latency roll up
   * into the result's totals.
   */
  async route(input: string, threshold: number = DEFAULT_CONFIDENCE_THRESHOLD): Promise<RouteResult> {
    const sidecarResult = await this.sidecar.classify(input);
    const sidecarRecord = {
      ...sidecarResult,
      costUsd: SIDECAR_COST_USD,
      latencyMs: SIDECAR_LATENCY_MS,
    };

    if (sidecarResult.confidence >= threshold) {
      this.sidecarPathRequests += 1;
      return {
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
    }

    this.foundationPathRequests += 1;
    const prompt = `Classify the urgency of this household message as urgent, routine, or informational, and explain why:\n\n"${input}"`;
    const foundationResult = await this.foundation.invoke(prompt);
    const foundationRecord = {
      ...foundationResult,
      costUsd: FOUNDATION_COST_USD,
      latencyMs: FOUNDATION_LATENCY_MS,
    };

    return {
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
  }

  /** Cumulative metrics across every request this router instance has handled. */
  getMetrics(): MetricsSnapshot {
    const totalRequests = this.sidecarPathRequests + this.foundationPathRequests;
    const actualCostUsd = this.sidecarPathRequests * SIDECAR_COST_USD + this.foundationPathRequests * (SIDECAR_COST_USD + FOUNDATION_COST_USD);
    const allFoundationCostUsd = totalRequests * FOUNDATION_COST_USD;
    const estimatedSavingsUsd = allFoundationCostUsd - actualCostUsd;

    return {
      totalRequests,
      sidecarPathRequests: this.sidecarPathRequests,
      foundationPathRequests: this.foundationPathRequests,
      sidecarPathRate: totalRequests === 0 ? 0 : this.sidecarPathRequests / totalRequests,
      actualCostUsd,
      allFoundationCostUsd,
      estimatedSavingsUsd,
      estimatedSavingsPct: allFoundationCostUsd === 0 ? 0 : (estimatedSavingsUsd / allFoundationCostUsd) * 100,
    };
  }

  /** Resets cumulative metrics to zero. Mainly useful for tests. */
  resetMetrics(): void {
    this.sidecarPathRequests = 0;
    this.foundationPathRequests = 0;
  }
}
