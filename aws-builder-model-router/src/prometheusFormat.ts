import type { CircuitState, MetricsSnapshot } from "./types.js";
import type { BudgetStatus } from "./budgetTracker.js";
import type { AlertWebhookStatus } from "./alertWebhooks.js";

/**
 * Renders the exact same cumulative numbers `GET /metrics` already reports
 * as JSON in the plain-text Prometheus exposition format instead, so a real
 * Prometheus server (or anything else that speaks the format —
 * `promtool check metrics`, Grafana Agent, VictoriaMetrics) can scrape this
 * router directly. `GET /metrics`'s JSON shape is unchanged; this is a pure
 * re-projection of the same underlying `MetricsSnapshot` (plus the default
 * budget and alert-webhook status, which live outside `MetricsSnapshot`
 * itself) onto a different wire format, computed fresh on every scrape —
 * there is no separate metrics-tracking code path to keep in sync.
 *
 * Deliberately minimal support for the format: every series is `# HELP` +
 * `# TYPE` + one or more `name{labels} value` lines, no timestamps (a scrape
 * is always "now"), and no histograms/summaries (nothing here is a
 * distribution). See https://github.com/prometheus/docs/blob/main/content/docs/instrumenting/exposition_formats.md
 * for the full spec this is a subset of.
 */

interface PrometheusRenderInput {
  metrics: MetricsSnapshot;
  defaultBudget: BudgetStatus;
  alertWebhook: AlertWebhookStatus;
}

type MetricType = "counter" | "gauge";

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return String(value);
}

/** Escapes a label value per the exposition format's rules (backslash, double-quote, newline). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  const rendered = Object.entries(labels)
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
  return `{${rendered}}`;
}

class MetricWriter {
  private readonly lines: string[] = [];
  private readonly declared = new Set<string>();

  /** Declares (once per metric name, even across multiple label-series) the `# HELP`/`# TYPE` pair, then appends one data line. */
  line(name: string, help: string, type: MetricType, value: number, labels?: Record<string, string>): void {
    if (!this.declared.has(name)) {
      this.lines.push(`# HELP ${name} ${help}`);
      this.lines.push(`# TYPE ${name} ${type}`);
      this.declared.add(name);
    }
    this.lines.push(`${name}${formatLabels(labels)} ${formatValue(value)}`);
  }

  render(): string {
    return this.lines.join("\n") + "\n";
  }
}

export function renderPrometheusMetrics({ metrics, defaultBudget, alertWebhook }: PrometheusRenderInput): string {
  const w = new MetricWriter();

  // --- Core routing counts ---
  w.line("model_router_requests_total", "Total classification requests handled (cache hits included).", "counter", metrics.totalRequests);
  w.line("model_router_sidecar_path_requests_total", "Requests resolved at the sidecar tier without escalation.", "counter", metrics.sidecarPathRequests);
  w.line("model_router_reviewer_path_requests_total", "Requests resolved at the mid-tier reviewer model.", "counter", metrics.reviewerPathRequests);
  w.line("model_router_foundation_path_requests_total", "Requests escalated all the way to the full foundation model.", "counter", metrics.foundationPathRequests);
  w.line("model_router_sidecar_path_rate", "Fraction of requests resolved at the sidecar tier (0..1).", "gauge", metrics.sidecarPathRate);
  w.line("model_router_reviewer_path_rate", "Fraction of requests resolved at the reviewer tier (0..1).", "gauge", metrics.reviewerPathRate);

  // --- Cost / savings ---
  w.line("model_router_cost_actual_usd", "Cumulative simulated cost actually incurred across every tier reached, in USD.", "counter", metrics.actualCostUsd);
  w.line("model_router_cost_all_foundation_usd", "Hypothetical cumulative cost if every request always hit the foundation model, in USD.", "counter", metrics.allFoundationCostUsd);
  w.line("model_router_estimated_savings_usd", "Estimated cumulative savings vs. always calling the foundation model, in USD.", "gauge", metrics.estimatedSavingsUsd);
  w.line("model_router_estimated_savings_pct", "Estimated cumulative savings vs. always calling the foundation model, as a percentage (0..100).", "gauge", metrics.estimatedSavingsPct);

  // --- Response cache ---
  w.line("model_router_cache_hits_total", "Response cache hits.", "counter", metrics.cacheHits);
  w.line("model_router_cache_misses_total", "Response cache misses.", "counter", metrics.cacheMisses);
  w.line("model_router_cache_hit_rate", "Response cache hit rate (0..1).", "gauge", metrics.cacheHitRate);

  // --- Circuit breaker / fallback ---
  w.line("model_router_fallback_requests_total", "Requests served by the sidecar fallback after a failed or circuit-open foundation call.", "counter", metrics.fallbackRequests);
  (["closed", "open", "half-open"] as CircuitState[]).forEach((state) => {
    w.line(
      "model_router_circuit_state",
      "Foundation-model circuit breaker state — 1 for the currently active state, 0 for the others, one series per possible state.",
      "gauge",
      metrics.circuitState === state ? 1 : 0,
      { state }
    );
  });

  // --- Shadow evaluation ---
  w.line("model_router_shadow_evaluations_total", "Background shadow evaluations of the foundation model against confident sidecar answers.", "counter", metrics.shadowEvaluations);
  w.line("model_router_shadow_agreements_total", "Shadow evaluations where the foundation model agreed with the sidecar's label.", "counter", metrics.shadowAgreements);
  w.line("model_router_shadow_agreement_rate", "Shadow-evaluation agreement rate (0..1).", "gauge", metrics.shadowAgreementRate);

  // --- Feedback / adaptive threshold ---
  w.line("model_router_feedback_total", "Caller feedback entries recorded with an explicit correct/incorrect verdict.", "counter", metrics.feedbackCount);
  w.line("model_router_current_threshold", "Confidence threshold most recently used by a classification (0..1).", "gauge", metrics.currentThreshold);
  if (metrics.suggestedThreshold !== null) {
    w.line("model_router_suggested_threshold", "The adaptive-threshold heuristic's currently suggested threshold (0..1), only present when it has one.", "gauge", metrics.suggestedThreshold);
  }

  // --- Cost-budget enforcement (default/global + per-caller) ---
  w.line("model_router_budget_throttled_requests_total", "Requests auto-throttled to the sidecar's best-effort answer because a cost budget was exhausted.", "counter", metrics.budgetThrottledRequests);
  w.line("model_router_budget_enabled", "Whether the shared/default cost budget is currently configured (1) or not (0).", "gauge", defaultBudget.enabled ? 1 : 0);
  if (defaultBudget.enabled) {
    w.line("model_router_budget_limit_usd", "Configured budget limit in USD per period, one series per caller ('__default__' for the shared fallback budget).", "gauge", defaultBudget.limitUsd ?? 0, { caller: "__default__" });
    w.line("model_router_budget_spend_usd", "Spend in USD for the active period, one series per caller ('__default__' for the shared fallback budget).", "gauge", defaultBudget.spendUsd, { caller: "__default__" });
    w.line("model_router_budget_exceeded", "Whether the current period's budget is exhausted (1) or not (0), one series per caller ('__default__' for the shared fallback budget).", "gauge", defaultBudget.exceeded ? 1 : 0, { caller: "__default__" });
  }
  for (const caller of metrics.callerBudgets) {
    w.line("model_router_budget_limit_usd", "Configured budget limit in USD per period, one series per caller ('__default__' for the shared fallback budget).", "gauge", caller.limitUsd ?? 0, { caller: caller.callerId });
    w.line("model_router_budget_spend_usd", "Spend in USD for the active period, one series per caller ('__default__' for the shared fallback budget).", "gauge", caller.spendUsd, { caller: caller.callerId });
    w.line("model_router_budget_exceeded", "Whether the current period's budget is exhausted (1) or not (0), one series per caller ('__default__' for the shared fallback budget).", "gauge", caller.exceeded ? 1 : 0, { caller: caller.callerId });
  }

  // --- Canary / A-B sidecar routing ---
  w.line("model_router_canary_enabled", "Whether a candidate sidecar is currently registered for canary/A-B routing (1) or not (0).", "gauge", metrics.canaryEnabled ? 1 : 0);
  w.line("model_router_canary_percentage", "Configured fraction of traffic routed to the candidate sidecar (0..1).", "gauge", metrics.canaryPercentage);
  w.line("model_router_canary_evaluations_total", "Requests where both the primary and candidate sidecar were evaluated on the same input.", "counter", metrics.canaryEvaluations);
  w.line("model_router_canary_disagreements_total", "Canary evaluations where the candidate's label differed from the primary's.", "counter", metrics.canaryDisagreements);
  w.line("model_router_canary_disagreement_rate", "Canary disagreement rate (0..1).", "gauge", metrics.canaryDisagreementRate);
  w.line("model_router_canary_served_requests_total", "Requests actually served by the candidate sidecar instead of the primary.", "counter", metrics.canaryServedRequests);

  // --- Outbound alert webhooks ---
  w.line("model_router_alert_webhook_registered", "Whether an outbound alert webhook callback is currently registered (1) or not (0).", "gauge", alertWebhook.registered ? 1 : 0);
  w.line("model_router_alert_webhook_deliveries_total", "Alert webhook deliveries that eventually received a 2xx response.", "counter", alertWebhook.deliveries);
  w.line("model_router_alert_webhook_failures_total", "Alert webhook deliveries that exhausted every retry without ever succeeding.", "counter", alertWebhook.failures);

  return w.render();
}
