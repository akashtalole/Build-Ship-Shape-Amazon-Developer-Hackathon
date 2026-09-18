import { randomBytes } from "node:crypto";
import { signPayload } from "./webhookAuth.js";
import { eventBus, type PorchPassEvent } from "./eventBus.js";

/**
 * Outbound webhook notifications — the *push* counterpart to the *pull*
 * `GET /events/stream` SSE feed. A homeowner who doesn't want to hold a
 * connection open registers their own callback URL (`POST /settings/webhook`)
 * and PorchPass POSTs the same event shape the SSE stream emits to it,
 * signed with the exact same HMAC-SHA256 scheme `webhookAuth.ts` uses to
 * *verify* inbound Ring events — just mirrored: here PorchPass is the
 * sender and the homeowner's endpoint is the verifier, using the secret
 * `GET /settings/webhook` hands back.
 *
 * One webhook registration per household, same granularity as
 * `settings.ts`'s quiet hours.
 */

export interface OutboundWebhookRegistration {
  url: string;
  secret: string;
  createdAt: string; // ISO timestamp
}

export interface OutboundWebhookDeliveryStatus {
  lastEventType?: PorchPassEvent["type"];
  lastAttemptAt?: string; // ISO timestamp of the most recent delivery attempt (of any outcome)
  lastAttempts?: number; // how many attempts that delivery took (1..MAX_ATTEMPTS)
  lastSuccessAt?: string; // ISO timestamp of the most recent 2xx response
  lastError?: string; // the most recent failure reason, cleared on the next success
  consecutiveFailures: number; // deliveries in a row that exhausted every retry without succeeding
}

// The event types this feature is scoped to notify on — matches the
// homeowner-facing "issued / visit / revoked-or-expired" framing exactly,
// even though the underlying event bus may carry other event types too.
const DELIVERABLE_EVENT_TYPES: ReadonlySet<PorchPassEvent["type"]> = new Set([
  "pass_issued",
  "visit_checkin",
  "visit_checkout",
  "pass_revoked",
  "pass_expired",
]);

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 300; // attempt 2 waits ~300ms, attempt 3 waits ~600ms

let registration: OutboundWebhookRegistration | undefined;
let status: OutboundWebhookDeliveryStatus = { consecutiveFailures: 0 };

export function getOutboundWebhook(): OutboundWebhookRegistration | undefined {
  return registration;
}

export function getOutboundWebhookStatus(): OutboundWebhookDeliveryStatus {
  return status;
}

/** Registering (even re-registering the same URL) issues a fresh secret — the homeowner reads it right back via the response and `GET /settings/webhook`. */
export function registerOutboundWebhook(url: string): OutboundWebhookRegistration {
  registration = { url, secret: randomBytes(24).toString("hex"), createdAt: new Date().toISOString() };
  status = { consecutiveFailures: 0 };
  return registration;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delivers one event with up to `MAX_ATTEMPTS` tries and exponential
 * backoff between them. Never throws — a delivery that exhausts every
 * attempt is recorded in `status` (observable via `GET /settings/webhook`)
 * rather than surfaced as an error anywhere, since nothing awaits this
 * function (see the `eventBus.subscribe` callback below).
 */
async function deliverWithRetry(url: string, payload: string, signature: string, eventType: PorchPassEvent["type"]): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    status = { ...status, lastEventType: eventType, lastAttemptAt: new Date().toISOString(), lastAttempts: attempt };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PorchPass-Signature": signature,
          "X-PorchPass-Event": eventType,
        },
        body: payload,
      });
      if (!res.ok) throw new Error(`Webhook endpoint responded with HTTP ${res.status}`);
      status = { ...status, lastSuccessAt: new Date().toISOString(), lastError: undefined, consecutiveFailures: 0 };
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status = { ...status, lastError: message, consecutiveFailures: status.consecutiveFailures + 1 };
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
}

// Fire-and-forget by construction: this subscribes to the same bus
// `passService.ts` publishes to *synchronously* on every state-changing
// action, and never awaits `deliverWithRetry` — so the request that
// triggered the event (issuing a pass, checking a visitor in, ...) returns
// to its caller without ever waiting on a slow or failing homeowner
// endpoint, no matter how many retries that delivery ends up taking.
eventBus.subscribe((event) => {
  if (!registration || !DELIVERABLE_EVENT_TYPES.has(event.type)) return;
  const { url, secret } = registration;
  const payload = JSON.stringify(event);
  const signature = signPayload(secret, payload);
  void deliverWithRetry(url, payload, signature, event.type);
});
