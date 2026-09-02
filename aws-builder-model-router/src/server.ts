import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ModelRouter } from "./router.js";
import { RateLimiter, type RateLimiterOptions } from "./rateLimiter.js";

/** Default quota: generous enough not to bother a real demo caller, tight enough to matter. */
const DEFAULT_RATE_LIMIT: RateLimiterOptions = { limit: 60, windowMs: 60_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateClassifyBody(body: unknown): { text: string; threshold?: number; shadowMode?: boolean } | { error: string } {
  const { text, threshold, shadowMode } = (body ?? {}) as Record<string, unknown>;

  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: "A non-empty 'text' string field is required." };
  }
  if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0 || threshold > 1)) {
    return { error: "'threshold', if provided, must be a number between 0 and 1." };
  }
  if (shadowMode !== undefined && typeof shadowMode !== "boolean") {
    return { error: "'shadowMode', if provided, must be a boolean." };
  }

  return { text, threshold: threshold as number | undefined, shadowMode: shadowMode as boolean | undefined };
}

/**
 * Builds the model-router Express app. Kept as a factory (rather than a
 * module-level app) so tests can wire in a fresh ModelRouter (and therefore
 * fresh metrics) per run instead of sharing state across test cases.
 *
 * `rateLimiter` is injectable so tests can use a small limit/window instead
 * of waiting out the production-sized default one.
 */
export function createApp(router: ModelRouter, options: { rateLimiter?: RateLimiter } = {}): Express {
  const app = express();
  app.use(express.json());

  const rateLimiter = options.rateLimiter ?? new RateLimiter(DEFAULT_RATE_LIMIT);

  // Per-caller quota (feature 6), keyed by the X-Caller-Id header. A missing
  // header falls back to a shared "anonymous" bucket rather than skipping
  // enforcement entirely — an unauthenticated caller still shouldn't be able
  // to exhaust a shared AWS resource for everyone else.
  function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const callerId = req.header("X-Caller-Id")?.trim() || "anonymous";
    const check = rateLimiter.check(callerId);
    res.setHeader("X-RateLimit-Limit", String(check.limit));
    res.setHeader("X-RateLimit-Remaining", String(check.remaining));
    if (!check.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(check.retryAfterMs / 1000)));
      res.status(429).json({
        error: `Rate limit exceeded for caller '${callerId}': max ${check.limit} requests per ${Math.round(
          DEFAULT_RATE_LIMIT.windowMs / 1000
        )}s window. Try again later, or use a different X-Caller-Id.`,
      });
      return;
    }
    next();
  }

  // Applies to both /classify and /classify/stream (Express matches app.use's
  // path as a prefix, so this single registration covers both).
  app.use("/classify", rateLimitMiddleware);

  app.post("/classify", async (req, res) => {
    const parsed = validateClassifyBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const result = await router.route(parsed.text, { threshold: parsed.threshold, shadowMode: parsed.shadowMode });
    res.status(200).json(result);
  });

  // Simulated streaming variant: for an escalation-path request, relays the
  // foundation model's answer as a sequence of Server-Sent Events instead of
  // one JSON blob — demonstrating how a real Bedrock
  // InvokeModelWithResponseStreamCommand call's chunks would be relayed to a
  // caller. See foundationModel.ts's doc comment for what a live version
  // would look like. Because MockBedrockProvider computes its whole answer
  // in one shot (there's no real streaming provider available here), this
  // chunks the already-complete text after the fact — a real integration
  // would instead forward each chunk as Bedrock produces it, which also
  // improves time-to-first-token instead of only presentation.
  app.post("/classify/stream", async (req, res) => {
    const parsed = validateClassifyBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const result = await router.route(parsed.text, { threshold: parsed.threshold, shadowMode: parsed.shadowMode });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering so chunks actually stream
    });

    const emit = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (result.path === "foundation" && result.foundation) {
      // Chunk by word to simulate token-by-token relay of the foundation model's answer.
      const tokens = result.foundation.text.split(/(\s+)/).filter((t) => t.length > 0);
      for (const token of tokens) {
        emit("chunk", { token });
        await sleep(2); // small, deterministic delay so chunks are genuinely separate writes, not one flush
      }
    } else {
      // Fast/fallback/cached paths have nothing to stream token-by-token — the whole answer was already available.
      emit("chunk", { token: result.label });
    }

    emit("done", result);
    res.end();
  });

  app.post("/feedback", (req, res) => {
    const { requestId, correct } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof requestId !== "string" || requestId.trim().length === 0) {
      res.status(400).json({ error: "A non-empty 'requestId' string field is required." });
      return;
    }
    if (typeof correct !== "boolean") {
      res.status(400).json({ error: "A boolean 'correct' field is required." });
      return;
    }
    const found = router.recordFeedback(requestId, correct);
    if (!found) {
      res.status(404).json({ error: `Unknown or expired requestId '${requestId}'.` });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.get("/metrics", (_req, res) => {
    res.json(router.getMetrics());
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
