import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findItemByName, itemsRunningLow, recordReorder } from "../store.js";
import { RESOURCE_URIS, type NotifyFn } from "../resources.js";

export function registerShoppingTools(server: McpServer, notify: NotifyFn): void {
  server.registerTool(
    "list_low_stock_items",
    {
      description:
        "List household items that are running low and may need reordering. " +
        "Use this to answer 'what's running low' or before offering to reorder anything.",
      inputSchema: {},
      outputSchema: {
        items: z.array(
          z.object({ id: z.string(), name: z.string(), quantityOnHand: z.number(), reorderThreshold: z.number() })
        ),
      },
      annotations: { title: "List low-stock items", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const items = itemsRunningLow();
      const text = items.length === 0 ? "Everything is well stocked." : items.map((i) => `- ${i.name} (${i.quantityOnHand} on hand)`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { items } };
    }
  );

  server.registerTool(
    "reorder_item",
    {
      description:
        "Reorder a household item by name. This is a spending action: it will ask the user " +
        "to confirm via MCP elicitation before purchasing. Pass confirm=true directly only if " +
        "the user has already confirmed in this conversation and the client doesn't support elicitation.",
      inputSchema: {
        itemName: z.string().min(1).describe("The item to reorder, e.g. 'dog food'."),
        confirm: z
          .boolean()
          .default(false)
          .describe("Skip the interactive confirmation and reorder immediately (only if already confirmed)."),
      },
      annotations: {
        title: "Reorder item",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ itemName, confirm }) => {
      const item = findItemByName(itemName);
      if (!item) {
        return { content: [{ type: "text", text: `I don't track an item called "${itemName}".` }], isError: true };
      }

      let approved = confirm === true;

      if (!approved) {
        try {
          // Prefer asking the client to elicit confirmation directly from
          // the user, rather than relying on a hand-rolled confirm flag.
          const elicited = await server.server.elicitInput({
            mode: "form",
            message: `${item.name} has ${item.quantityOnHand} on hand. Reorder it now?`,
            requestedSchema: {
              type: "object",
              properties: {
                confirmReorder: {
                  type: "boolean",
                  title: "Confirm reorder",
                  default: true,
                },
              },
              required: ["confirmReorder"],
            },
          });

          if (elicited.action !== "accept" || !elicited.content?.confirmReorder) {
            return { content: [{ type: "text", text: `Okay, I won't reorder ${item.name}.` }] };
          }
          approved = true;
        } catch {
          // Client hasn't declared the elicitation capability — fall back
          // to a two-step preview so the tool still degrades gracefully.
          return {
            content: [
              {
                type: "text",
                text:
                  `${item.name} has ${item.quantityOnHand} on hand. ` +
                  `Call reorder_item again with confirm=true once the user approves.`,
              },
            ],
          };
        }
      }

      const updated = recordReorder(item.id)!;
      await notify(RESOURCE_URIS.lowStock);
      return {
        content: [
          { type: "text", text: `Reordered ${updated.name}. It now shows ${updated.quantityOnHand} on hand once delivered.` },
        ],
      };
    }
  );
}
