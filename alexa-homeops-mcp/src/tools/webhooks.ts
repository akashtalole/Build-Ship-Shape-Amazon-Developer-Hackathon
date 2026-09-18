import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAlertWebhookRegistration, registerAlertWebhook } from "../store.js";
import { getWebhookDeliveryStatus } from "../webhookDelivery.js";
import { logEvent } from "../logging.js";

export function registerWebhookTools(server: McpServer, householdId: string): void {
  server.registerTool(
    "register_alert_webhook",
    {
      description:
        "Register (or replace) this household's callback URL for proactive alerts — fired when add_expense " +
        "pushes a category over its weekly budget, or when a task operation (add_task, import_tasks, " +
        "sync_household_calendar) reveals something overdue. Alerts are POSTed as JSON and signed with " +
        "HMAC-SHA256 (header X-HomeOps-Signature, over the raw request body) using the secret returned here, " +
        "so your endpoint can verify a payload genuinely came from this server before trusting it. " +
        "Re-registering issues a brand-new secret and replaces the previous URL.",
      inputSchema: {
        url: z.string().url().describe("HTTPS endpoint that will receive POSTed alert payloads."),
      },
      outputSchema: { url: z.string(), secret: z.string(), createdAt: z.string() },
      annotations: {
        title: "Register alert webhook",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      const registration = registerAlertWebhook(householdId, url);
      await logEvent(server, "info", "Alert webhook registered", { url });
      return {
        content: [
          {
            type: "text",
            text:
              `Registered ${url} for this household's alerts. Verify inbound payloads with HMAC-SHA256 ` +
              `(header X-HomeOps-Signature) using this secret, shown once: ${registration.secret}`,
          },
        ],
        structuredContent: { url: registration.url, secret: registration.secret, createdAt: registration.createdAt },
      };
    }
  );

  server.registerTool(
    "get_alert_webhook_status",
    {
      description:
        "Show whether this household has a registered alert webhook, and the outcome of its most recent " +
        "delivery attempt (success, failure, consecutive-failure count). Never returns the signing secret.",
      inputSchema: {},
      annotations: { title: "Get alert webhook status", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const registration = getAlertWebhookRegistration(householdId);
      if (!registration) {
        return {
          content: [
            { type: "text", text: "No alert webhook registered for this household. Use register_alert_webhook to add one." },
          ],
        };
      }
      const status = getWebhookDeliveryStatus(householdId);
      const lines = [
        `Webhook: ${registration.url} (registered ${registration.createdAt})`,
        status?.lastAttemptAt
          ? `Last delivery attempt: ${status.lastAttemptAt} (${status.lastAlertType})`
          : "No deliveries attempted yet.",
      ];
      if (status?.lastSuccessAt) lines.push(`Last success: ${status.lastSuccessAt}`);
      if (status?.lastError) {
        lines.push(`Last error: ${status.lastError} (${status.consecutiveFailures} consecutive failure(s))`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
