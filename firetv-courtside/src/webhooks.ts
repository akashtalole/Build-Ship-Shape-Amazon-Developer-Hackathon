import { createHmac, randomBytes } from "node:crypto";
import { checkRateLimit } from "./rateLimiter.js";
import { listSubscriptions } from "./store.js";
import type { CommentaryLine, GameEvent, Subscription } from "./types.js";

/**
 * Outbound score-alert delivery for `POST /games/:id/subscriptions`. Whenever
 * `gameService.ingestEvent` decides an event is notable (see `isNotableEvent`
 * in gameService.ts), it calls `notifySubscribers` here, which fans the event
 * out to every subscription on that game — signed, rate-capped, and retried
 * on failure, entirely off the ingestion request's critical path (the caller
 * never awaits this module).
 */

/**
 * Per-subscription cap on alert deliveries per rolling window. A burst of
 * notable events (several quick go-ahead scores) beyond this cap is dropped
 * for that subscription rather than queued or batched: the receiver gets the
 * most recent alerts, not an ever-growing backlog, and nothing is actually
 * lost — the full, uncapped history is always available via
 * `GET /games/:id/highlights`. See FRICTION_LOG.md for why "drop" was chosen
 * over "batch" here.
 */
export const SUBSCRIPTION_ALERT_RATE_MAX = 5;
export const SUBSCRIPTION_ALERT_RATE_WINDOW_MS = 60_000;

const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 150;

/** A fresh per-subscription HMAC-SHA256 signing secret, returned once in the registration response. */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Signs a raw request body with a subscription's secret — the same computation a receiver does to verify it. */
export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export interface NotableEventPayload {
  type: "notable_event";
  gameId: string;
  event: GameEvent;
  commentary: CommentaryLine;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverOnce(callbackUrl: string, subscriptionId: string, body: string, signature: string): Promise<boolean> {
  try {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Same convention as GitHub/Stripe-style webhooks: "<algo>=<hex digest>" so a
        // receiver can support multiple signing schemes on the same header in future.
        "X-CourtSide-Signature": `sha256=${signature}`,
        "X-CourtSide-Subscription-Id": subscriptionId,
      },
      body,
    });
    return res.ok;
  } catch {
    return false; // network error, DNS failure, receiver down, etc. — treated the same as a bad status for retry purposes
  }
}

/** Delivers one payload to one subscription, retrying on failure with exponential backoff (up to 3 attempts total). */
export async function deliverWithRetry(subscription: Subscription, payload: NotableEventPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = signPayload(subscription.secret, body);

  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    const ok = await deliverOnce(subscription.callbackUrl, subscription.id, body, signature);
    if (ok) return;

    if (attempt < MAX_DELIVERY_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)); // 150ms, then 300ms
    } else {
      console.error(
        `CourtSide webhook: giving up on subscription ${subscription.id} (${subscription.callbackUrl}) after ${MAX_DELIVERY_ATTEMPTS} attempts.`
      );
    }
  }
}

/**
 * Fans a notable event out to every subscription registered on its game —
 * except a player-scoped subscription (`subscription.playerName` set, see
 * `subscribeToGame` in gameService.ts), which only fires when this event's
 * `player` field names that player (case-insensitive, exact match). A fan
 * who only cares about their favorite player's moments never hears about
 * every other notable event in the game.
 *
 * Synchronous from the caller's point of view (`ingestEvent` calls this
 * without `await`): rate-limit checks happen immediately, but the actual
 * HTTP deliveries (and any retries) run as detached promises so a slow or
 * dead receiver never adds latency to `POST /games/:id/events`.
 */
export function notifySubscribers(gameId: string, event: GameEvent, commentary: CommentaryLine): void {
  const subscriptions = listSubscriptions(gameId).filter(
    (sub) => !sub.playerName || (event.player?.trim().toLowerCase() === sub.playerName.trim().toLowerCase())
  );
  if (subscriptions.length === 0) return;

  const payload: NotableEventPayload = { type: "notable_event", gameId, event, commentary };

  for (const subscription of subscriptions) {
    const rateLimit = checkRateLimit(
      `webhook:${subscription.id}`,
      SUBSCRIPTION_ALERT_RATE_MAX,
      SUBSCRIPTION_ALERT_RATE_WINDOW_MS
    );
    if (!rateLimit.allowed) {
      console.warn(`CourtSide webhook: dropping alert for subscription ${subscription.id} — rate cap exceeded.`);
      continue;
    }
    void deliverWithRetry(subscription, payload);
  }
}
