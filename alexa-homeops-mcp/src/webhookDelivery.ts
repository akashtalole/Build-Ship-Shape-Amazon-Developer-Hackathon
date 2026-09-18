import { createHmac } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAlertWebhookRegistration } from "./store.js";
import { logEvent } from "./logging.js";

/**
 * Outbound household-alert webhooks — the push counterpart to this server's
 * MCP resource-update notifications, for the many real-world cases where
 * nothing is holding an MCP session open to receive them (a household
 * automation, a separate notification service, a text-message bridge).
 * Mirrors, in spirit, the outbound-webhook pattern this repo's
 * ring-porchpass and firetv-courtside services use for their own push
 * notifications: a registered callback URL, an HMAC-SHA256 signature over
 * the raw JSON body so the receiver can verify the payload actually came
 * from this server, and retry-with-backoff so one slow response doesn't
 * lose an alert.
 */

export type HouseholdAlertType = "budget_exceeded" | "task_overdue";

export interface HouseholdAlertPayload {
  type: HouseholdAlertType;
  householdId: string;
  message: string;
  data: Record<string, unknown>;
  firedAt: string; // ISO timestamp
}

export interface WebhookDeliveryStatus {
  lastAlertType?: HouseholdAlertType;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  consecutiveFailures: number;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200; // attempt 2 waits ~200ms, attempt 3 waits ~400ms

// Delivery status is observability only (surfaced via get_alert_webhook_status)
// — intentionally in-memory, same tradeoff as store.ts's reorder-idempotency
// cache: it only needs to survive the life of the process, not a restart.
const statusByHousehold = new Map<string, WebhookDeliveryStatus>();

export function getWebhookDeliveryStatus(householdId: string): WebhookDeliveryStatus | undefined {
  return statusByHousehold.get(householdId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Computes the HMAC-SHA256 signature (hex) for a given secret + raw body — exported so the smoke test can verify it independently, the same way a real subscriber would. */
export function signAlertPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function deliverWithRetry(
  householdId: string,
  url: string,
  secret: string,
  payload: HouseholdAlertPayload,
  server: McpServer
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = signAlertPayload(secret, body);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const priorStatus = statusByHousehold.get(householdId) ?? { consecutiveFailures: 0 };
    statusByHousehold.set(householdId, {
      ...priorStatus,
      lastAlertType: payload.type,
      lastAttemptAt: new Date().toISOString(),
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-HomeOps-Signature": signature,
          "X-HomeOps-Alert-Type": payload.type,
        },
        body,
      });
      if (!res.ok) throw new Error(`Webhook endpoint responded with HTTP ${res.status}`);

      statusByHousehold.set(householdId, {
        ...statusByHousehold.get(householdId)!,
        lastSuccessAt: new Date().toISOString(),
        lastError: undefined,
        consecutiveFailures: 0,
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = statusByHousehold.get(householdId)!;
      statusByHousehold.set(householdId, {
        ...current,
        lastError: message,
        consecutiveFailures: current.consecutiveFailures + 1,
      });

      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      } else {
        await logEvent(server, "warning", "Webhook delivery failed after retries", {
          householdId,
          alertType: payload.type,
          attempts: attempt,
          error: message,
        });
      }
    }
  }
}

/**
 * Fires a proactive alert to the household's registered webhook, if any —
 * a no-op if none is registered. Fire-and-forget by construction (the
 * `void` below is the only call site): the tool call that triggered this
 * (add_expense going over budget, a sync revealing an overdue task) returns
 * to its caller immediately, never blocked on a slow or unreachable
 * endpoint no matter how many of the retry attempts that takes.
 */
export function fireHouseholdAlert(
  server: McpServer,
  householdId: string,
  alert: { type: HouseholdAlertType; message: string; data: Record<string, unknown> }
): void {
  const registration = getAlertWebhookRegistration(householdId);
  if (!registration) return;

  const payload: HouseholdAlertPayload = { ...alert, householdId, firedAt: new Date().toISOString() };
  void deliverWithRetry(householdId, registration.url, registration.secret, payload, server);
}
