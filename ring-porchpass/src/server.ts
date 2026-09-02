import express, { type Express } from "express";
import { checkIn, issuePass, listPasses, listVisits, revokePass } from "./passService.js";
import type { RingClient } from "./ringClient.js";
import type { Notifier } from "./notify.js";
import { getWebhookSecret, verifySignature } from "./webhookAuth.js";
import { getSettings, updateSettings } from "./settings.js";
import { eventBus, type PorchPassEvent } from "./eventBus.js";

// Augment Express's Request with the raw body bytes captured by the
// `express.json({ verify })` hook below — HMAC signature verification needs
// the exact bytes Ring signed, not the re-serialized parsed object, since
// re-serializing JSON is not guaranteed to byte-for-byte match the original.
declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds the PorchPass Express app. Kept as a factory (rather than a
 * module-level app) so tests can wire in a fresh SimulatedRingClient and
 * LoggingNotifier per run instead of sharing state across test cases.
 */
export function createApp(ringClient: RingClient, notifier: Notifier): Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(express.urlencoded({ extended: false }));

  // --- Homeowner-facing API: issue, list, revoke passes ---

  app.post("/passes", async (req, res) => {
    const { visitorName, visitorPhone, validUntil, validFrom, maxUses, note, recurrence, allowQuietHours, idempotencyKey } =
      req.body ?? {};
    if (!visitorName || !visitorPhone || !validUntil) {
      res.status(400).json({ error: "visitorName, visitorPhone, and validUntil are required." });
      return;
    }
    if (recurrence !== undefined) {
      const validShape =
        Array.isArray(recurrence.daysOfWeek) &&
        recurrence.daysOfWeek.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
        typeof recurrence.startTime === "string" &&
        typeof recurrence.endTime === "string";
      if (!validShape) {
        res.status(400).json({
          error: "recurrence must be { daysOfWeek: number[0-6], startTime: 'HH:MM', endTime: 'HH:MM' } (UTC).",
        });
        return;
      }
    }
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const pass = await issuePass(
      { visitorName, visitorPhone, validFrom, validUntil, maxUses, note, recurrence, allowQuietHours, idempotencyKey, baseUrl },
      notifier
    );
    // Same 201 whether this created a new pass or replayed an existing one
    // under the same idempotency key — the caller's request "succeeded"
    // either way, and the response body (the pass) tells them which pass
    // that is either way.
    res.status(201).json(pass);
  });

  app.get("/passes", (_req, res) => {
    res.json(listPasses());
  });

  app.delete("/passes/:id", (req, res) => {
    const pass = revokePass(req.params.id);
    if (!pass) {
      res.status(404).json({ error: "No pass with that ID." });
      return;
    }
    res.json(pass);
  });

  app.get("/visits", (_req, res) => {
    res.json(listVisits());
  });

  // --- Household settings (quiet hours, etc.) ---

  app.get("/settings", (_req, res) => {
    res.json(getSettings());
  });

  app.post("/settings", (req, res) => {
    const { quietHours } = req.body ?? {};
    if (quietHours !== null && quietHours !== undefined) {
      if (typeof quietHours.start !== "string" || typeof quietHours.end !== "string") {
        res.status(400).json({ error: "quietHours requires { start: 'HH:MM', end: 'HH:MM' } (UTC)." });
        return;
      }
    }
    const updated = updateSettings({ quietHours: quietHours ?? undefined });
    res.json(updated);
  });

  // --- Real-time homeowner dashboard feed (additive to GET /visits) ---

  app.get("/events/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Some proxies (nginx) buffer SSE responses by default; this header
      // is the standard opt-out. Harmless when there's no such proxy.
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected\n\n`);

    const send = (event: PorchPassEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = eventBus.subscribe(send);

    // Keep intermediary proxies/load balancers from timing out an otherwise
    // idle-looking long-lived connection.
    const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- Visitor-facing flow: no app or account required, just the link ---

  app.get("/checkin/:token", (req, res) => {
    res.type("html").send(`<!doctype html>
<html><body style="font-family: sans-serif; max-width: 420px; margin: 3rem auto; text-align: center;">
  <h1>You've arrived 👋</h1>
  <p>Tap below to let the household know you're here.</p>
  <form method="POST" action="/checkin/${escapeHtml(req.params.token)}">
    <button type="submit" style="font-size: 1.1rem; padding: 0.75rem 1.5rem;">I'm here</button>
  </form>
</body></html>`);
  });

  app.post("/checkin/:token", async (req, res) => {
    const result = await checkIn(req.params.token, ringClient, notifier);
    const status = result.rateLimited ? 429 : result.ok ? 200 : 409;
    const wantsJson = req.accepts(["html", "json"]) === "json";
    if (wantsJson) {
      res.status(status).json(result);
      return;
    }
    res.status(status).type("html").send(`<!doctype html>
<html><body style="font-family: sans-serif; max-width: 420px; margin: 3rem auto; text-align: center;">
  <h1>${result.ok ? "Thanks, you're all set!" : "Hmm, that didn't work"}</h1>
  <p>${escapeHtml(result.ok ? "The household has been notified you're here." : result.reason ?? "Please contact the household directly.")}</p>
</body></html>`);
  });

  // --- Ring event ingress. A real deployment replaces this handler's body
  // with parsing Ring's actual webhook payload; the simulator's shape is
  // deliberately similar (deviceId + event type) so that swap is small.
  // The signature check, however, mirrors real webhook authentication and
  // would carry over unchanged. ---

  app.post("/ring/events", async (req, res) => {
    const secret = getWebhookSecret();
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = req.get("X-Ring-Signature");
    if (!verifySignature(secret, rawBody, signature)) {
      res.status(401).json({ error: "Missing or invalid X-Ring-Signature." });
      return;
    }

    const { deviceId, type } = req.body ?? {};
    if (!deviceId || (type !== "ding" && type !== "motion")) {
      res.status(400).json({ error: "deviceId and type ('ding'|'motion') are required." });
      return;
    }
    const event = await ringClient.emitEvent(deviceId, type);
    res.status(201).json(event);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
