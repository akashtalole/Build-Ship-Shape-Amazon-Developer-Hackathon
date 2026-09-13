import { fileURLToPath } from "node:url";
import { createApp } from "./server.js";
import { ModelRouter } from "./router.js";
import { MockSidecarClassifier } from "./sidecarClassifier.js";
import { MockBedrockProvider } from "./foundationModel.js";
import { MockReviewerProvider } from "./reviewerModel.js";

const PORT = Number(process.env.PORT ?? 4567);

// Demo-grade metrics persistence (feature: persistent metrics) — see
// metricsPersistence.ts for exactly what this file does and doesn't
// guarantee. Lives at the package root regardless of the process's cwd.
const METRICS_PATH = process.env.MODEL_ROUTER_METRICS_PATH ?? fileURLToPath(new URL("../metrics-state.json", import.meta.url));

// Demo-grade audit-trail persistence (feature: per-request audit trail
// export, round 5) — see auditTrail.ts. Lives alongside the metrics file,
// at the package root regardless of the process's cwd.
const AUDIT_LOG_PATH = process.env.MODEL_ROUTER_AUDIT_LOG_PATH ?? fileURLToPath(new URL("../audit-log.jsonl", import.meta.url));

const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
  reviewer: new MockReviewerProvider(),
  metricsPersistPath: METRICS_PATH,
  auditLogPath: AUDIT_LOG_PATH,
});
const app = createApp(router);

const server = app.listen(PORT, () => {
  console.log(`Model router listening on http://localhost:${PORT}`);
  console.log(`Classify a message:        POST http://localhost:${PORT}/classify  { "text": "..." }`);
  console.log(`Streamed classification:   POST http://localhost:${PORT}/classify/stream  { "text": "..." }`);
  console.log(`Report classification feedback: POST http://localhost:${PORT}/feedback  { "requestId": "...", "correct": true }`);
  console.log(`Set a cost budget:         POST http://localhost:${PORT}/budget  { "limit": 0.05, "periodMs": 3600000 }  (add X-Caller-Id to scope it to one caller)`);
  console.log(`View budget status:        GET  http://localhost:${PORT}/budget  (or GET /budget/all for every caller)`);
  console.log(`Register a canary sidecar: POST http://localhost:${PORT}/router/canary  { "percentage": 0.3, "config": { "confidenceScale": 0.8 } }`);
  console.log(`Register an alert webhook: POST http://localhost:${PORT}/alerts/webhook  { "url": "https://example.com/hook" }`);
  console.log(`Configure drift sampling:  POST http://localhost:${PORT}/drift/config  { "sampleRate": 0.1, "windowSize": 20, "alertThreshold": 0.8 }`);
  console.log(`View drift status:         GET  http://localhost:${PORT}/drift/status`);
  console.log(`Register an ensemble:      POST http://localhost:${PORT}/router/ensemble  { "members": [{ "weight": 1, "config": {} }] }`);
  console.log(`Cost-optimization report:  GET  http://localhost:${PORT}/recommendations/cost`);
  console.log(`Audit trail export:        GET  http://localhost:${PORT}/audit/export?since=<ISO timestamp>`);
  console.log(`View metrics:              GET  http://localhost:${PORT}/metrics`);
  console.log(`View metrics (Prometheus): GET  http://localhost:${PORT}/metrics/prometheus`);
  console.log(`Metrics persisted to:      ${METRICS_PATH}`);
  console.log(`Audit trail persisted to:  ${AUDIT_LOG_PATH}`);
});

// Graceful shutdown: persist cumulative metrics one last time so restarting
// the demo doesn't reset the cost-savings story back to zero (feature:
// persistent metrics). The periodic every-N-requests auto-save (see
// router.ts's `notePersist`) covers the "the process just got killed" case
// too, but a clean shutdown should never rely on having gotten lucky with
// the last auto-save's timing.
function shutdown(signal: string): void {
  console.log(`\nReceived ${signal} — persisting metrics to ${METRICS_PATH} and shutting down...`);
  router.persistMetricsNow();
  server.close(() => process.exit(0));
  // Belt-and-suspenders: force-exit if something (an open keep-alive socket)
  // keeps the server from closing promptly.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
