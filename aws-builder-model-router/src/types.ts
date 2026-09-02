/**
 * Shared types for the model-router demo: an urgency classifier for
 * household-automation-style messages (the kind a HomeOps/Alexa+ style
 * assistant, a Ring/Bee style notification pipeline, etc. might need to
 * triage). The pattern itself is task-agnostic — swap the label set and the
 * sidecar's heuristics for any other narrow classification task.
 */

/** The three urgency buckets the demo task classifies messages into. */
export type UrgencyLabel = "urgent" | "routine" | "informational";

/** Which path a given request took through the router. */
export type RoutePath = "sidecar" | "foundation";

/** Result shape returned by a SageMaker-runtime-style classifier endpoint. */
export interface SidecarResult {
  label: string;
  confidence: number; // 0..1
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
  input: string;
  threshold: number;
  path: RoutePath;
  label: string;
  confidence: number;
  explanation: string;
  sidecar: SidecarResult & CostEstimate;
  foundation?: FoundationResult & CostEstimate;
  totalCostUsd: number;
  totalLatencyMs: number;
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
}
