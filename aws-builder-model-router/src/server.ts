import express, { type Express } from "express";
import { ModelRouter } from "./router.js";

/**
 * Builds the model-router Express app. Kept as a factory (rather than a
 * module-level app) so tests can wire in a fresh ModelRouter (and therefore
 * fresh metrics) per run instead of sharing state across test cases.
 */
export function createApp(router: ModelRouter): Express {
  const app = express();
  app.use(express.json());

  app.post("/classify", async (req, res) => {
    const { text, threshold } = req.body ?? {};

    if (typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: "A non-empty 'text' string field is required." });
      return;
    }

    if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0 || threshold > 1)) {
      res.status(400).json({ error: "'threshold', if provided, must be a number between 0 and 1." });
      return;
    }

    const result = await router.route(text, threshold);
    res.status(200).json(result);
  });

  app.get("/metrics", (_req, res) => {
    res.json(router.getMetrics());
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
