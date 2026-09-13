import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ModelRouter } from "./router.js";
import { RateLimiter, type RateLimiterOptions } from "./rateLimiter.js";
import { MockSidecarClassifier, type SidecarClassifierConfig } from "./sidecarClassifier.js";
import { renderPrometheusMetrics } from "./prometheusFormat.js";

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

/** The per-caller identification convention shared by rate limiting, per-caller budgets, and routing: an explicit `X-Caller-Id` header, or the shared "anonymous" bucket when a caller doesn't supply one. */
function callerIdOrAnonymous(req: Request): string {
  return req.header("X-Caller-Id")?.trim() || "anonymous";
}

/**
 * Same header, but returns `undefined` (rather than falling back to
 * "anonymous") when it's missing — used by the budget endpoints, where a
 * missing header means "the shared/default budget," not "the 'anonymous'
 * caller's own budget." Keeping these two readers distinct is what lets
 * `POST /budget` (global, no header) and `POST /classify` (always resolves
 * *some* caller id) both reuse the same `X-Caller-Id` convention without
 * a bare, unauthenticated caller accidentally getting their own budget
 * bucket the first time anyone configures one.
 */
function explicitCallerId(req: Request): string | undefined {
  return req.header("X-Caller-Id")?.trim() || undefined;
}

function isValidUrgencyLabel(value: unknown): value is "urgent" | "routine" | "informational" {
  return value === "urgent" || value === "routine" || value === "informational";
}

/** Validates an optional `POST /router/canary` `config` body field into a `SidecarClassifierConfig`, or returns an error string. */
function validateCanaryConfig(config: unknown): SidecarClassifierConfig | { error: string } {
  if (config === undefined) return {};
  if (typeof config !== "object" || config === null) return { error: "'config', if provided, must be an object." };
  const { extraKeywords, confidenceScale } = config as Record<string, unknown>;

  let parsedExtraKeywords: SidecarClassifierConfig["extraKeywords"];
  if (extraKeywords !== undefined) {
    if (!Array.isArray(extraKeywords)) return { error: "'config.extraKeywords', if provided, must be an array." };
    parsedExtraKeywords = [];
    for (const entry of extraKeywords) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !isValidUrgencyLabel((entry as Record<string, unknown>).label) ||
        !Array.isArray((entry as Record<string, unknown>).keywords) ||
        !(entry as { keywords: unknown[] }).keywords.every((k) => typeof k === "string")
      ) {
        return { error: "Each 'config.extraKeywords' entry must be { label: 'urgent'|'routine'|'informational', keywords: string[] }." };
      }
      parsedExtraKeywords.push(entry as { label: "urgent" | "routine" | "informational"; keywords: string[] });
    }
  }

  if (confidenceScale !== undefined && (typeof confidenceScale !== "number" || !Number.isFinite(confidenceScale) || confidenceScale < 0)) {
    return { error: "'config.confidenceScale', if provided, must be a non-negative number." };
  }

  return { extraKeywords: parsedExtraKeywords, confidenceScale: confidenceScale as number | undefined };
}

/** Validates a `POST /router/ensemble` body into `{members, primaryWeight}`, or returns an error string. Each member's own `config` reuses `validateCanaryConfig`'s exact validation (both ultimately construct a `MockSidecarClassifier`). */
function validateEnsembleBody(body: unknown): { members: { classifier: MockSidecarClassifier; weight?: number; name?: string }[]; primaryWeight?: number } | { error: string } {
  const { members, primaryWeight } = (body ?? {}) as Record<string, unknown>;

  if (!Array.isArray(members) || members.length === 0) {
    return { error: "A non-empty 'members' array is required — each entry may have 'weight' (positive number) and/or 'config' (like /router/canary's)." };
  }
  if (primaryWeight !== undefined && (typeof primaryWeight !== "number" || !Number.isFinite(primaryWeight) || primaryWeight <= 0)) {
    return { error: "'primaryWeight', if provided, must be a positive number." };
  }

  const parsedMembers: { classifier: MockSidecarClassifier; weight?: number; name?: string }[] = [];
  for (const entry of members) {
    if (typeof entry !== "object" || entry === null) {
      return { error: "Each 'members' entry must be an object." };
    }
    const { weight, name, config } = entry as Record<string, unknown>;
    if (weight !== undefined && (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)) {
      return { error: "Each member's 'weight', if provided, must be a positive number." };
    }
    if (name !== undefined && typeof name !== "string") {
      return { error: "Each member's 'name', if provided, must be a string." };
    }
    const parsedConfig = validateCanaryConfig(config);
    if ("error" in parsedConfig) return { error: `member config: ${parsedConfig.error}` };
    parsedMembers.push({ classifier: new MockSidecarClassifier(parsedConfig), weight: weight as number | undefined, name: name as string | undefined });
  }

  return { members: parsedMembers, primaryWeight: primaryWeight as number | undefined };
}

/** Validates a `POST /drift/config` body, or returns an error string. */
function validateDriftConfigBody(body: unknown): { sampleRate: number; windowSize?: number; alertThreshold?: number } | { error: string } {
  const { sampleRate, windowSize, alertThreshold } = (body ?? {}) as Record<string, unknown>;

  if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    return { error: "A numeric 'sampleRate' between 0 and 1 (inclusive) is required." };
  }
  if (windowSize !== undefined && (typeof windowSize !== "number" || !Number.isInteger(windowSize) || windowSize < 1)) {
    return { error: "'windowSize', if provided, must be a positive integer." };
  }
  if (alertThreshold !== undefined && (typeof alertThreshold !== "number" || !Number.isFinite(alertThreshold) || alertThreshold < 0 || alertThreshold > 1)) {
    return { error: "'alertThreshold', if provided, must be a number between 0 and 1 (inclusive)." };
  }

  return { sampleRate, windowSize: windowSize as number | undefined, alertThreshold: alertThreshold as number | undefined };
}

/** Parses `GET /audit/export`'s optional `?since=` query param (an ISO timestamp or epoch-milliseconds string) into epoch milliseconds, or returns an error string. */
function parseSinceParam(value: unknown): number | undefined | { error: string } {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.trim().length === 0) return { error: "'since', if provided, must be a non-empty string (an ISO timestamp or epoch milliseconds)." };
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && raw.trim() === String(asNumber)) return asNumber;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return { error: "'since' must be a valid ISO timestamp or epoch-milliseconds value." };
  return parsed;
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
    const callerId = callerIdOrAnonymous(req);
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

    const result = await router.route(parsed.text, {
      threshold: parsed.threshold,
      shadowMode: parsed.shadowMode,
      callerId: callerIdOrAnonymous(req),
    });
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

    const result = await router.route(parsed.text, {
      threshold: parsed.threshold,
      shadowMode: parsed.shadowMode,
      callerId: callerIdOrAnonymous(req),
    });

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

  // Cost-budget enforcement (feature: cost-budget enforcement), scoped per
  // caller (round 4). See budgetTracker.ts for exactly what "limit"/"periodMs"
  // mean (a fixed-window dollar cap on paid-tier — reviewer + foundation —
  // spend). An explicit `X-Caller-Id` header scopes the request to that
  // caller's own independent budget; omitting it (as every pre-round-4 call
  // shape does) configures/reads the shared default that any caller without
  // their own override falls back to — see `explicitCallerId()`'s doc
  // comment for why this deliberately does *not* default to "anonymous"
  // the way rate limiting and `/classify` do.
  app.post("/budget", (req, res) => {
    const { limit, periodMs } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      res.status(400).json({ error: "A positive numeric 'limit' (dollars per period) is required." });
      return;
    }
    if (typeof periodMs !== "number" || !Number.isFinite(periodMs) || periodMs <= 0) {
      res.status(400).json({ error: "A positive numeric 'periodMs' (period length in milliseconds) is required." });
      return;
    }
    const callerId = explicitCallerId(req);
    router.setBudget(limit, periodMs, callerId);
    res.status(200).json(router.getBudgetStatus(callerId));
  });

  app.get("/budget", (req, res) => {
    res.json(router.getBudgetStatus(explicitCallerId(req)));
  });

  // Clears the shared default budget (no header), or one caller's own
  // override (with a header) — the caller then falls back to the shared
  // default rather than becoming fully unbudgeted, unless that's also unset.
  app.delete("/budget", (req, res) => {
    router.clearBudget(explicitCallerId(req));
    res.status(200).json(router.getBudgetStatus(explicitCallerId(req)));
  });

  // Admin/dashboard view of every caller with an *explicit* budget override
  // configured, alongside the shared default they'd otherwise fall back to.
  app.get("/budget/all", (_req, res) => {
    res.json({ default: router.getBudgetStatus(), callers: router.getMetrics().callerBudgets });
  });

  // Canary/A-B sidecar routing (round 4): a second "candidate" sidecar
  // classifier evaluated alongside the primary on every request, with a
  // configurable share of traffic actually served by its answer. See
  // sidecarClassifier.ts's `SidecarClassifierConfig` for what `config` tunes.
  app.post("/router/canary", (req, res) => {
    const { percentage, config } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 1) {
      res.status(400).json({ error: "A numeric 'percentage' between 0 and 1 (inclusive) is required." });
      return;
    }
    const parsedConfig = validateCanaryConfig(config);
    if ("error" in parsedConfig) {
      res.status(400).json({ error: parsedConfig.error });
      return;
    }
    router.setCanary(percentage, new MockSidecarClassifier(parsedConfig));
    res.status(200).json(router.getCanaryStatus());
  });

  app.get("/router/canary", (_req, res) => {
    res.json(router.getCanaryStatus());
  });

  app.delete("/router/canary", (_req, res) => {
    router.clearCanary();
    res.status(200).json(router.getCanaryStatus());
  });

  // Multi-sidecar ensemble voting (round 5): registers 2+ voting members
  // (the primary plus one or more extras) whose votes are *combined* into
  // one weighted answer per request — distinct from canary/A-B routing just
  // above, which *splits* traffic between two versions instead. See
  // ModelRouter.setEnsemble()'s doc comment and the README's "Multi-sidecar
  // ensemble voting" section for exactly how the two differ.
  app.post("/router/ensemble", (req, res) => {
    const parsed = validateEnsembleBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    router.setEnsemble(parsed.members, parsed.primaryWeight);
    res.status(200).json(router.getEnsembleStatus());
  });

  app.get("/router/ensemble", (_req, res) => {
    res.json(router.getEnsembleStatus());
  });

  app.delete("/router/ensemble", (_req, res) => {
    router.clearEnsemble();
    res.status(200).json(router.getEnsembleStatus());
  });

  // Sidecar drift detection (round 5): samples a configurable fraction of
  // otherwise-confident sidecar-path traffic through the foundation model
  // purely to watch for drift, tracked over a rolling window with alerting
  // via the existing outbound webhook mechanism. See
  // ModelRouter.configureDriftDetection()'s doc comment for exactly how this
  // differs from shadow evaluation.
  app.post("/drift/config", (req, res) => {
    const parsed = validateDriftConfigBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    router.configureDriftDetection(parsed);
    res.status(200).json(router.getDriftStatus());
  });

  app.get("/drift/status", (_req, res) => {
    res.json(router.getDriftStatus());
  });

  app.delete("/drift/config", (_req, res) => {
    router.disableDriftDetection();
    res.status(200).json(router.getDriftStatus());
  });

  // Cost-optimization recommender (round 5): a concrete, numerically-computed
  // suggestion derived from the router's own accumulated escalation history
  // and feedback/shadow-evaluation accuracy data — never a canned message.
  // See ModelRouter.generateCostRecommendation()'s doc comment.
  app.get("/recommendations/cost", (_req, res) => {
    res.json(router.generateCostRecommendation());
  });

  // Per-request audit trail export (round 5): a compliance/cost-review-ready
  // export of routing decisions, reusing the metrics-persistence file-based
  // approach (see auditTrail.ts) rather than a second storage mechanism.
  app.get("/audit/export", (req, res) => {
    const since = parseSinceParam(req.query.since);
    if (since !== undefined && typeof since === "object") {
      res.status(400).json({ error: since.error });
      return;
    }
    const limitRaw = req.query.limit;
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const limitValue = Number(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw);
      if (!Number.isFinite(limitValue) || !Number.isInteger(limitValue) || limitValue <= 0) {
        res.status(400).json({ error: "'limit', if provided, must be a positive integer." });
        return;
      }
      limit = limitValue;
    }
    res.json(router.exportAuditTrail({ sinceMs: since, limit }));
  });

  // Outbound alert webhooks (round 4): a registered callback URL gets an
  // HMAC-SHA256-signed POST whenever a cost budget is exceeded or the
  // circuit breaker opens. See alertWebhooks.ts.
  app.post("/alerts/webhook", (req, res) => {
    const { url } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof url !== "string" || url.trim().length === 0) {
      res.status(400).json({ error: "A non-empty 'url' string field is required." });
      return;
    }
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: "'url' must be a valid absolute URL." });
      return;
    }
    const registration = router.registerAlertWebhook(url);
    // The secret is only ever handed back here, at registration time — same
    // convention as ring-porchpass's outbound webhook registration. Losing
    // it means re-registering (which issues a fresh one).
    res.status(200).json({ url: registration.url, secret: registration.secret, createdAt: registration.createdAt });
  });

  app.get("/alerts/webhook", (_req, res) => {
    res.json(router.getAlertWebhookStatus());
  });

  app.delete("/alerts/webhook", (_req, res) => {
    router.clearAlertWebhook();
    res.status(200).json({ registered: false });
  });

  app.get("/metrics", (_req, res) => {
    res.json(router.getMetrics());
  });

  // Prometheus-format export of the exact same numbers GET /metrics reports
  // as JSON (feature: Prometheus-format metrics export). See
  // prometheusFormat.ts.
  app.get("/metrics/prometheus", (_req, res) => {
    const body = renderPrometheusMetrics({
      metrics: router.getMetrics(),
      defaultBudget: router.getBudgetStatus(),
      alertWebhook: router.getAlertWebhookStatus(),
    });
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(body);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
