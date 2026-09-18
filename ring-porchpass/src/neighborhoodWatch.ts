import { randomBytes, randomUUID } from "node:crypto";
import { deliverSignedPayload } from "./outboundWebhooks.js";

/**
 * Neighborhood alert broadcast (round 5). When PorchPass notices a real risk
 * pattern on a pass — repeated failed/expired check-in attempts in a short
 * window, or any attempt at all on a pass that's already been revoked — it
 * broadcasts a simulated "neighborhood watch" alert to every OTHER
 * simulated household that's opted in, not just the owning household's own
 * webhook/SSE channels. This is a real community-safety feature Ring itself
 * leans into (Neighbors), modeled here with real risk-pattern detection and
 * real signed delivery, not a stub.
 *
 * Delivery reuses `outboundWebhooks.ts`'s exact signing/retry mechanism
 * (`deliverSignedPayload`) rather than a second implementation — each
 * subscriber gets its own PorchPass-generated secret (same pattern as
 * `registerOutboundWebhook`), and a broadcast is fire-and-forget for the
 * same reason an ordinary outbound webhook delivery is: a slow or broken
 * neighbor's endpoint must never block the check-in attempt that triggered
 * the alert.
 */

// --- Risk detection --------------------------------------------------------

export type RiskSignalType = "repeated_failed_checkins" | "checkin_after_revocation";

export interface RiskSignal {
  type: RiskSignalType;
  passId: string;
  detail: string;
}

const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const FAILURE_THRESHOLD = 3; // failed/expired attempts within the window

const failureTimestampsByPassId = new Map<string, number[]>();
const revocationAttemptAlerted = new Set<string>();

/**
 * Records one failed/expired check-in attempt against `passId` and returns a
 * risk signal the *moment* the rolling window crosses `FAILURE_THRESHOLD` —
 * exactly once per crossing, not on every attempt after (so a pass being
 * hammered doesn't flood the neighborhood with a duplicate alert per try).
 */
export function recordFailedCheckIn(passId: string, now: number = Date.now()): RiskSignal | undefined {
  const recent = (failureTimestampsByPassId.get(passId) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  recent.push(now);
  failureTimestampsByPassId.set(passId, recent);
  if (recent.length === FAILURE_THRESHOLD) {
    return {
      type: "repeated_failed_checkins",
      passId,
      detail: `${FAILURE_THRESHOLD} failed or expired check-in attempts on this pass within ${Math.round(FAILURE_WINDOW_MS / 60000)} minutes.`,
    };
  }
  return undefined;
}

/**
 * Records a check-in attempt against an already-revoked pass. Alerts once
 * per pass (not on every repeat attempt against the same already-flagged
 * pass) — the household already knows it revoked the pass; what's newsworthy
 * to the neighborhood is that *someone tried anyway*, once.
 */
export function recordRevokedCheckInAttempt(passId: string): RiskSignal | undefined {
  if (revocationAttemptAlerted.has(passId)) return undefined;
  revocationAttemptAlerted.add(passId);
  return {
    type: "checkin_after_revocation",
    passId,
    detail: "A check-in was attempted on a pass after the household had already revoked it.",
  };
}

// --- Subscriber registry ----------------------------------------------------

export interface NeighborhoodSubscriber {
  id: string;
  url: string;
  secret: string; // PorchPass-generated, shared once at registration — same pattern as registerOutboundWebhook
  addedAt: string; // ISO timestamp
}

const subscribers = new Map<string, NeighborhoodSubscriber>();

export function listNeighborhoodSubscribers(): NeighborhoodSubscriber[] {
  return [...subscribers.values()].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

export function addNeighborhoodSubscriber(url: string): NeighborhoodSubscriber {
  const subscriber: NeighborhoodSubscriber = {
    id: randomUUID(),
    url,
    secret: randomBytes(24).toString("hex"),
    addedAt: new Date().toISOString(),
  };
  subscribers.set(subscriber.id, subscriber);
  return subscriber;
}

export function removeNeighborhoodSubscriber(id: string): boolean {
  return subscribers.delete(id);
}

// --- Broadcast ---------------------------------------------------------------

export interface NeighborhoodAlert {
  id: string;
  at: string; // ISO timestamp
  type: RiskSignalType;
  passId: string;
  visitorName: string;
  detail: string;
  deliveredTo: number; // how many subscribers this was broadcast to
}

// A short in-memory log of alerts actually broadcast — observable via
// GET /neighborhood/alerts, same "don't let this disappear into a server
// log no one's watching" reasoning as outboundWebhooks.ts's delivery status.
const alertLog: NeighborhoodAlert[] = [];

export function listNeighborhoodAlerts(): NeighborhoodAlert[] {
  return [...alertLog].reverse();
}

/**
 * Broadcasts one alert to every registered neighborhood subscriber. Genuinely
 * fire-and-forget, for the same structural reason `outboundWebhooks.ts` is:
 * the `void` here means there's no `await` to accidentally add later that
 * would block the check-in request that triggered this on a slow or broken
 * neighbor's endpoint.
 */
export function broadcastNeighborhoodAlert(signal: RiskSignal, visitorName: string): NeighborhoodAlert {
  const subscriberList = listNeighborhoodSubscribers();
  const alert: NeighborhoodAlert = {
    id: randomUUID(),
    at: new Date().toISOString(),
    type: signal.type,
    passId: signal.passId,
    visitorName,
    detail: signal.detail,
    deliveredTo: subscriberList.length,
  };
  alertLog.push(alert);

  const payload = JSON.stringify({ event: "neighborhood_watch_alert", alert });
  for (const subscriber of subscriberList) {
    void deliverSignedPayload(subscriber.url, subscriber.secret, payload, "neighborhood_watch_alert");
  }
  return alert;
}
