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

const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider(), {
  reviewer: new MockReviewerProvider(),
  metricsPersistPath: METRICS_PATH,
});
const app = createApp(router);

const server = app.listen(PORT, () => {
  console.log(`Model router listening on http://localhost:${PORT}`);
  console.log(`Classify a message:        POST http://localhost:${PORT}/classify  { "text": "..." }`);
  console.log(`Streamed classification:   POST http://localhost:${PORT}/classify/stream  { "text": "..." }`);
  console.log(`Report classification feedback: POST http://localhost:${PORT}/feedback  { "requestId": "...", "correct": true }`);
  console.log(`Set a cost budget:         POST http://localhost:${PORT}/budget  { "limit": 0.05, "periodMs": 3600000 }`);
  console.log(`View budget status:        GET  http://localhost:${PORT}/budget`);
  console.log(`View metrics:              GET  http://localhost:${PORT}/metrics`);
  console.log(`Metrics persisted to:      ${METRICS_PATH}`);
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
