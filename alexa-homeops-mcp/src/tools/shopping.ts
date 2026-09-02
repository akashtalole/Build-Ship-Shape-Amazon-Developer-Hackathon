import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findItemByName, itemsRunningLow, recordReorder } from "../store.js";

export function registerShoppingTools(server: McpServer): void {
  server.registerTool(
    "list_low_stock_items",
    {
      description:
        "List household items that are running low and may need reordering. " +
        "Use this to answer 'what's running low' or before offering to reorder anything.",
      inputSchema: {},
    },
    async () => {
      const items = itemsRunningLow();
      if (items.length === 0) {
        return { content: [{ type: "text", text: "Everything is well stocked." }] };
      }
      const lines = items.map((i) => `- ${i.name} (${i.quantityOnHand} on hand)`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "reorder_item",
    {
      description:
        "Reorder a household item by name. This is a spending action: call it once with " +
        "confirm=false (or omitted) to preview what would happen, and only call it again " +
        "with confirm=true after the user has explicitly approved the purchase.",
      inputSchema: {
        itemName: z.string().min(1).describe("The item to reorder, e.g. 'dog food'."),
        confirm: z
          .boolean()
          .default(false)
          .describe("Set to true only after the user has explicitly confirmed the reorder."),
      },
    },
    async ({ itemName, confirm }) => {
      const item = findItemByName(itemName);
      if (!item) {
        return { content: [{ type: "text", text: `I don't track an item called "${itemName}".` }], isError: true };
      }

      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text:
                `${item.name} has ${item.quantityOnHand} on hand. ` +
                `Reordering will restock it. Confirm the reorder to proceed?`,
            },
          ],
        };
      }

      const updated = recordReorder(item.id);
      return {
        content: [
          {
            type: "text",
            text: `Reordered ${updated!.name}. It now shows ${updated!.quantityOnHand} on hand once delivered.`,
          },
        ],
      };
    }
  );
}
