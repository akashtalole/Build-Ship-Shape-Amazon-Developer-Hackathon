import { randomBytes, createHmac } from "node:crypto";

/**
 * Outbound alert webhooks — the router's first *push* notification surface.
 * Everything else an operator can observe (`GET /metrics`, `GET /budget`,
 * `GET /router/canary`) is *pull*: something you have to remember to poll.
 * This mirrors `ring-porchpass`'s `outboundWebhooks.ts` pattern (itself the
 * sender-side mirror of that service's own `webhookAuth.ts`, which verifies
 * *inbound* Ring events): a single registered callback URL gets a fresh
 * random secret at registration time, and every alert is POSTed to it with
 * an HMAC-SHA256 signature over the raw JSON body so the operator's endpoint
 * can verify it really came from this router and not from anyone who merely
 * guessed the URL.
 *
 * Scope is deliberately narrow for this demo: exactly one registered
 * callback (like `ring-porchpass`'s one-webhook-per-household granularity),
 * and exactly two alert types — the two conditions an operator actually
 * wants to know about *without* polling `/metrics`:
 *   - `budget_exceeded`: a (global or per-caller) cost budget was just
 *     exhausted, so the router started auto-throttling escalations.
 *   - `circuit_open`: the foundation-model circuit breaker just tripped, so
 *     requests are falling back to the sidecar's best-effort answer.
 *
 * Fire-and-forget by construction: `fire()` is called from deep inside
 * `ModelRouter.route()` and must never make a slow or failing operator
 * endpoint add latency to (or fail) the classification request that
 * triggered the alert. `flush()` exists purely so tests (and any caller that
 * wants delivery to have actually completed) can await the in-flight
 * deliveries deterministically instead of guessing with a sleep — see
 * `ModelRouter.flushAlertWebhooks()`.
 */

export type AlertEventType = "budget_exceeded" | "circuit_open";

export interface AlertEvent {
  type: AlertEventType;
  occurredAt: string; // ISO timestamp
  detail: Record<string, unknown>;
}

export interface AlertWebhookRegistration {
  url: string;
  secret: string;
  createdAt: string; // ISO timestamp
}

export interface AlertWebhookStatus {
  registered: boolean;
  url?: string;
  lastEventType?: AlertEventType;
  lastAttemptAt?: string; // ISO timestamp of the most recent delivery attempt (of any outcome)
  lastAttempts?: number; // how many attempts that delivery took (1..MAX_ATTEMPTS)
  lastSuccessAt?: string; // ISO timestamp of the most recent 2xx response
  lastError?: string; // the most recent failure reason, cleared on the next success
  consecutiveFailures: number; // deliveries in a row that exhausted every retry without succeeding
  deliveries: number; // total deliveries that eventually got a 2xx response
  failures: number; // total deliveries that exhausted every retry without ever succeeding
}

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 200; // attempt 2 waits ~200ms, attempt 3 waits ~400ms

/** Computes the signature header value for a given secret + raw (already-serialized) payload — same HMAC-SHA256-over-raw-body scheme as `ring-porchpass`'s `webhookAuth.ts`. */
export function signAlertPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EMPTY_STATUS: AlertWebhookStatus = { registered: false, consecutiveFailures: 0, deliveries: 0, failures: 0 };

export class AlertWebhookDispatcher {
  private registration?: AlertWebhookRegistration;
  private status: AlertWebhookStatus = { ...EMPTY_STATUS };
  private pending: Promise<void>[] = [];

  /** Registering (even re-registering the same URL) issues a fresh secret and resets delivery history. */
  register(url: string): AlertWebhookRegistration {
    this.registration = { url, secret: randomBytes(24).toString("hex"), createdAt: new Date().toISOString() };
    this.status = { registered: true, url, consecutiveFailures: 0, deliveries: 0, failures: 0 };
    return this.registration;
  }

  /** Removes the registration entirely — subsequent alerts are silently dropped (matching `fire()`'s no-op-when-unregistered behavior) until a new one is registered. */
  clear(): void {
    this.registration = undefined;
    this.status = { ...EMPTY_STATUS };
  }

  getRegistration(): AlertWebhookRegistration | undefined {
    return this.registration;
  }

  getStatus(): AlertWebhookStatus {
    return this.status;
  }

  /**
   * Fires one alert. A no-op (not an error) when nothing is registered — the
   * same "alerting is opt-in, silently absent by default" convention as
   * every other feature in this router that needs explicit configuration
   * before it does anything (the cost budget, the reviewer tier, the
   * canary). Never awaited by the caller; see this file's doc comment.
   */
  fire(type: AlertEventType, detail: Record<string, unknown>): void {
    if (!this.registration) return;
    const event: AlertEvent = { type, occurredAt: new Date().toISOString(), detail };
    const payload = JSON.stringify(event);
    const signature = signAlertPayload(this.registration.secret, payload);
    const promise = this.deliverWithRetry(this.registration.url, payload, signature, type);
    this.pending.push(promise);
  }

  /** Waits for every delivery kicked off by `fire()` so far to settle (success or all-retries-exhausted). See this file's doc comment for why `fire()` itself is never awaited. */
  async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    await Promise.all(pending);
  }

  /** Never throws — a delivery that exhausts every attempt is recorded in `status` (observable via `GET /alerts/webhook`) rather than surfaced as an error anywhere. */
  private async deliverWithRetry(url: string, payload: string, signature: string, type: AlertEventType): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.status = { ...this.status, lastEventType: type, lastAttemptAt: new Date().toISOString(), lastAttempts: attempt };
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-ModelRouter-Signature": signature,
            "X-ModelRouter-Event": type,
          },
          body: payload,
        });
        if (!res.ok) throw new Error(`Webhook endpoint responded with HTTP ${res.status}`);
        this.status = {
          ...this.status,
          lastSuccessAt: new Date().toISOString(),
          lastError: undefined,
          consecutiveFailures: 0,
          deliveries: this.status.deliveries + 1,
        };
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.status = { ...this.status, lastError: message, consecutiveFailures: this.status.consecutiveFailures + 1 };
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
        } else {
          this.status = { ...this.status, failures: this.status.failures + 1 };
        }
      }
    }
  }
}
