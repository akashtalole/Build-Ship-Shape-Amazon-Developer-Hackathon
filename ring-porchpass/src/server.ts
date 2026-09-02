import express, { type Express } from "express";
import { checkIn, issuePass, listPasses, listVisits, revokePass } from "./passService.js";
import type { RingClient } from "./ringClient.js";
import type { Notifier } from "./notify.js";

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
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // --- Homeowner-facing API: issue, list, revoke passes ---

  app.post("/passes", async (req, res) => {
    const { visitorName, visitorPhone, validUntil, validFrom, maxUses, note } = req.body ?? {};
    if (!visitorName || !visitorPhone || !validUntil) {
      res.status(400).json({ error: "visitorName, visitorPhone, and validUntil are required." });
      return;
    }
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const pass = await issuePass({ visitorName, visitorPhone, validFrom, validUntil, maxUses, note, baseUrl }, notifier);
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
    const wantsJson = req.accepts(["html", "json"]) === "json";
    if (wantsJson) {
      res.status(result.ok ? 200 : 409).json(result);
      return;
    }
    res.type("html").send(`<!doctype html>
<html><body style="font-family: sans-serif; max-width: 420px; margin: 3rem auto; text-align: center;">
  <h1>${result.ok ? "Thanks, you're all set!" : "Hmm, that didn't work"}</h1>
  <p>${escapeHtml(result.ok ? "The household has been notified you're here." : result.reason ?? "Please contact the household directly.")}</p>
</body></html>`);
  });

  // --- Ring event ingress. A real deployment replaces this handler's body
  // with parsing Ring's actual webhook payload; the simulator's shape is
  // deliberately similar (deviceId + event type) so that swap is small. ---

  app.post("/ring/events", async (req, res) => {
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
