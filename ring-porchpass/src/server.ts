import express, { type Express } from "express";
import { checkIn, decideExtension, issuePass, listPasses, listVisits, requestExtension, revokePass } from "./passService.js";
import type { IssuePassInput } from "./passService.js";
import type { Pass, RecurrenceRule } from "./types.js";
import type { RingClient } from "./ringClient.js";
import type { Notifier } from "./notify.js";
import { getWebhookSecret, verifySignature } from "./webhookAuth.js";
import { getSettings, updateSettings } from "./settings.js";
import { eventBus, type PorchPassEvent } from "./eventBus.js";
import { listDevices, registerDevice } from "./devices.js";
import { getOutboundWebhook, getOutboundWebhookStatus, registerOutboundWebhook } from "./outboundWebhooks.js";
import { getPassIdByIdempotencyKey } from "./store.js";

// Augment Express's Request with the raw body bytes captured by the
// `express.json({ verify })` hook below — HMAC signature verification needs
// the exact bytes Ring signed, not the re-serialized parsed object, since
// re-serializing JSON is not guaranteed to byte-for-byte match the original.
declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}

/** Same shape check `POST /passes` and `POST /passes/bulk` both need for an optional `recurrence` field. */
function recurrenceShapeError(recurrence: unknown): string | undefined {
  if (recurrence === undefined) return undefined;
  const r = recurrence as Partial<RecurrenceRule> | null;
  const validShape =
    !!r &&
    Array.isArray(r.daysOfWeek) &&
    r.daysOfWeek.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
    typeof r.startTime === "string" &&
    typeof r.endTime === "string";
  return validShape ? undefined : "recurrence must be { daysOfWeek: number[0-6], startTime: 'HH:MM', endTime: 'HH:MM' } (UTC).";
}

/** Same shape check `POST /passes` and `POST /passes/bulk` both need for an optional `deviceIds` field. */
function deviceIdsShapeError(deviceIds: unknown): string | undefined {
  if (deviceIds === undefined) return undefined;
  const validShape = Array.isArray(deviceIds) && deviceIds.length > 0 && deviceIds.every((d) => typeof d === "string" && d.length > 0);
  return validShape ? undefined : "deviceIds must be a non-empty array of non-empty device ID strings.";
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
    const { visitorName, visitorPhone, validUntil, validFrom, maxUses, note, recurrence, allowQuietHours, idempotencyKey, deviceIds } =
      req.body ?? {};
    if (!visitorName || !visitorPhone || !validUntil) {
      res.status(400).json({ error: "visitorName, visitorPhone, and validUntil are required." });
      return;
    }
    const recurrenceError = recurrenceShapeError(recurrence);
    if (recurrenceError) {
      res.status(400).json({ error: recurrenceError });
      return;
    }
    const deviceIdsError = deviceIdsShapeError(deviceIds);
    if (deviceIdsError) {
      res.status(400).json({ error: deviceIdsError });
      return;
    }
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const pass = await issuePass(
      { visitorName, visitorPhone, validFrom, validUntil, maxUses, note, recurrence, allowQuietHours, idempotencyKey, deviceIds, baseUrl },
      notifier
    );
    // Same 201 whether this created a new pass or replayed an existing one
    // under the same idempotency key — the caller's request "succeeded"
    // either way, and the response body (the pass) tells them which pass
    // that is either way.
    res.status(201).json(pass);
  });

  // --- Bulk/template issuance: one call issues many passes, reusing the same
  // `issuePass` (and, through it, all its idempotency/recurrence/notification
  // logic) once per item rather than duplicating any of it. ---

  app.post("/passes/bulk", async (req, res) => {
    const { template, variations, idempotencyKeyPrefix } = req.body ?? {};
    if (!Array.isArray(variations) || variations.length === 0) {
      res.status(400).json({ error: "variations must be a non-empty array of per-pass field overrides." });
      return;
    }
    if (template !== undefined && (typeof template !== "object" || template === null || Array.isArray(template))) {
      res.status(400).json({ error: "template, if given, must be an object of fields shared by every variation." });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const results: Array<{ index: number; status: "created" | "replayed" | "error"; pass?: Pass; error?: string }> = [];

    for (let i = 0; i < variations.length; i++) {
      const variation = variations[i];
      if (typeof variation !== "object" || variation === null || Array.isArray(variation)) {
        results.push({ index: i, status: "error", error: "Each entry in variations must be an object." });
        continue;
      }
      // The variation overrides the template field-by-field — e.g. a
      // template carrying the shared visitorPhone/note/validUntil, with each
      // variation supplying just the visitorName (a different visitor per
      // weekday) or just an explicit validFrom/validUntil window.
      const merged = { ...(template ?? {}), ...variation };
      const { visitorName, visitorPhone, validUntil, validFrom, maxUses, note, recurrence, allowQuietHours, deviceIds } = merged;
      const idempotencyKey: string | undefined = merged.idempotencyKey ?? (idempotencyKeyPrefix ? `${idempotencyKeyPrefix}${i}` : undefined);

      if (!visitorName || !visitorPhone || !validUntil) {
        results.push({
          index: i,
          status: "error",
          error: "visitorName, visitorPhone, and validUntil are required, once the template and this variation are merged.",
        });
        continue;
      }
      const recurrenceError = recurrenceShapeError(recurrence);
      if (recurrenceError) {
        results.push({ index: i, status: "error", error: recurrenceError });
        continue;
      }
      const deviceIdsError = deviceIdsShapeError(deviceIds);
      if (deviceIdsError) {
        results.push({ index: i, status: "error", error: deviceIdsError });
        continue;
      }

      // Determine created-vs-replayed *before* calling issuePass, since
      // issuePass itself returns the same shape (a Pass) either way.
      const isReplay = !!(idempotencyKey && getPassIdByIdempotencyKey(idempotencyKey));
      try {
        const pass = await issuePass(
          { visitorName, visitorPhone, validFrom, validUntil, maxUses, note, recurrence, allowQuietHours, deviceIds, idempotencyKey, baseUrl } as IssuePassInput,
          notifier
        );
        results.push({ index: i, status: isReplay ? "replayed" : "created", pass });
      } catch (err) {
        results.push({ index: i, status: "error", error: err instanceof Error ? err.message : "Unknown error issuing this pass." });
      }
    }

    const anyErrors = results.some((r) => r.status === "error");
    res.status(anyErrors ? 207 : 201).json({ results });
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

  // --- Grace-period extension: the homeowner's side of the decision. The
  // visitor's side (requesting one) lives in the check-in flow below. ---

  app.post("/passes/:id/extension/approve", async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const result = await decideExtension(req.params.id, true, notifier, baseUrl);
    res.status(result.ok ? 200 : result.pass ? 409 : 404).json(result);
  });

  app.post("/passes/:id/extension/deny", async (req, res) => {
    const result = await decideExtension(req.params.id, false, notifier);
    res.status(result.ok ? 200 : result.pass ? 409 : 404).json(result);
  });

  // --- Ring device registry ---

  app.get("/devices", (_req, res) => {
    res.json(listDevices());
  });

  app.post("/devices", (req, res) => {
    const { id, name } = req.body ?? {};
    if (typeof id !== "string" || id.length === 0) {
      res.status(400).json({ error: "id is required." });
      return;
    }
    if (name !== undefined && typeof name !== "string") {
      res.status(400).json({ error: "name must be a string if provided." });
      return;
    }
    const device = registerDevice(id, { name, via: "explicit" });
    res.status(201).json(device);
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

  // --- Outbound webhook: the push counterpart to GET /events/stream ---

  app.post("/settings/webhook", (req, res) => {
    const { url } = req.body ?? {};
    if (typeof url !== "string" || url.length === 0) {
      res.status(400).json({ error: "url is required." });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      res.status(400).json({ error: "url must be a valid absolute URL." });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      res.status(400).json({ error: "url must use http:// or https://." });
      return;
    }
    const registration = registerOutboundWebhook(url);
    res.status(201).json(registration);
  });

  app.get("/settings/webhook", (_req, res) => {
    const registration = getOutboundWebhook();
    if (!registration) {
      res.status(404).json({ error: "No webhook is registered. POST /settings/webhook to register one." });
      return;
    }
    res.json({ ...registration, deliveryStatus: getOutboundWebhookStatus() });
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
    // A pass that just expired, and hasn't asked before, gets an extra
    // button here instead of only a dead end — see `graceEligible` on
    // `CheckInResult` and `POST /checkin/:token/request-extension` below.
    const extensionForm = result.graceEligible
      ? `<form method="POST" action="/checkin/${escapeHtml(req.params.token)}/request-extension" style="margin-top: 1rem;">
    <button type="submit" style="font-size: 1rem; padding: 0.6rem 1.2rem;">Request a few more minutes</button>
  </form>`
      : "";
    res.status(status).type("html").send(`<!doctype html>
<html><body style="font-family: sans-serif; max-width: 420px; margin: 3rem auto; text-align: center;">
  <h1>${result.ok ? "Thanks, you're all set!" : "Hmm, that didn't work"}</h1>
  <p>${escapeHtml(result.ok ? "The household has been notified you're here." : result.reason ?? "Please contact the household directly.")}</p>
  ${extensionForm}
</body></html>`);
  });

  // --- Grace-period extension: the visitor's side of the request. ---

  app.post("/checkin/:token/request-extension", async (req, res) => {
    const result = await requestExtension(req.params.token, notifier);
    const status = result.ok ? 201 : 409;
    const wantsJson = req.accepts(["html", "json"]) === "json";
    if (wantsJson) {
      res.status(status).json(result);
      return;
    }
    res.status(status).type("html").send(`<!doctype html>
<html><body style="font-family: sans-serif; max-width: 420px; margin: 3rem auto; text-align: center;">
  <h1>${result.ok ? "Request sent" : "Couldn't request an extension"}</h1>
  <p>${escapeHtml(result.ok ? "The household has been notified and will approve or deny your request shortly." : result.reason ?? "Please contact the household directly.")}</p>
</body></html>`);
  });

  // --- Ring event ingress. A real deployment replaces this handler's body
  // with parsing Ring's actual webhook payload; the simulator's shape is
  // deliberately similar (deviceId + event type) so that swap is small.
  // The signature check, however, mirrors real webhook authentication and
  // would carry over unchanged. Any deviceId is accepted — front door, back
  // door, garage, whatever Ring device sent it — and implicitly registered
  // in the device directory (`GET /devices`) the first time it's seen. ---

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
