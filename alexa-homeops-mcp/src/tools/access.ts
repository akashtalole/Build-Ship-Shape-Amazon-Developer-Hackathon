import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { issueToken } from "../auth.js";

/**
 * Registers the one tool a household uses to mint additional bearer tokens
 * for itself — e.g. a `read-only` token for a kid's device or a shared
 * kitchen display that should be able to check what's due or how the budget
 * looks, but never add, edit, or spend anything, alongside the `full-access`
 * token a parent already holds. This tool is itself a write operation (it
 * mutates the token registry), so — like every other write tool — a
 * read-only session is rejected before ever reaching the handler below (see
 * ../rbac.ts): a read-only token can never mint itself, or anyone else, a
 * more powerful one.
 */
export function registerAccessTools(server: McpServer, householdId: string): void {
  server.registerTool(
    "issue_household_token",
    {
      description:
        "Mint a new bearer token for THIS household with a chosen access role. Use 'read-only' for a " +
        "household member or device that should only ever list/check things (tasks, budget, low-stock, the " +
        "digest export) and never add, edit, spend, or register anything. Use 'full-access' for a token that " +
        "should be able to do everything this one can. The token is shown only once, in this response — store " +
        "it wherever the other client will read its Authorization header from.",
      inputSchema: {
        role: z
          .enum(["full-access", "read-only"])
          .default("read-only")
          .describe("Access level for the newly issued token."),
      },
      outputSchema: {
        token: z.string(),
        role: z.enum(["full-access", "read-only"]),
        householdId: z.string(),
      },
      annotations: {
        title: "Issue household token",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ role }) => {
      const token = issueToken(householdId, role);
      return {
        content: [
          {
            type: "text",
            text:
              `Issued a new ${role} token for this household (shown once): ${token}\n` +
              `Have the other client connect with "Authorization: Bearer ${token}".`,
          },
        ],
        structuredContent: { token, role, householdId },
      };
    }
  );
}
