import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addExpense, addTask, reportLowStock } from "../store.js";
import { RESOURCE_URIS, type NotifyFn } from "../resources.js";
import { logEvent } from "../logging.js";
import { applyExpenseFollowUps } from "./expenses.js";
import { DATE_PATTERN } from "./tasks.js";

/**
 * capture_note is the freeform front door to everything else this server
 * does: a household member shouldn't need to know that "we're almost out of
 * coffee" is a shopping-list operation while "pick up dry cleaning by
 * Friday" is a task, or which tool name maps to which. This asks the
 * connected client's own model (the same MCP-sampling pattern
 * generate_weekly_narrative already uses — no bundled model key here either)
 * to classify one sentence into shopping/task/expense and dispatches into
 * the corresponding existing store function, rather than adding a fourth,
 * competing way to create any of those records.
 */

const classificationSchema = z
  .object({
    type: z.enum(["shopping", "task", "expense"]),
    item: z.string().optional(),
    title: z.string().optional(),
    dueDate: z.string().optional(),
    assignee: z.string().optional(),
    description: z.string().optional(),
    amount: z.number().optional(),
    category: z.string().optional(),
  })
  .passthrough();

type Classification = z.infer<typeof classificationSchema>;

/** Pulls the first balanced-looking `{...}` JSON object out of a model response, tolerating a ```json fence around it. */
function extractJson(text: string): unknown | undefined {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

async function classifyNote(server: McpServer, text: string): Promise<Classification | undefined> {
  try {
    const result = await server.server.createMessage({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Classify this one household note into exactly one of three categories, and respond with ONLY " +
              "strict JSON (no prose, no code fence) in one of these exact shapes:\n" +
              '  {"type":"shopping","item":"<item name, singular>"}\n' +
              '  {"type":"task","title":"<short task title>","dueDate":"<YYYY-MM-DD, omit if not mentioned>","assignee":"<name, omit if not mentioned>"}\n' +
              '  {"type":"expense","description":"<what it was for>","amount":<number>,"category":"<one-word category>"}\n' +
              'Use "shopping" only when something is running low or needs to be bought. Use "expense" only when a ' +
              'specific amount of money is mentioned. Use "task" for everything else that needs doing.\n\n' +
              `Note: "${text}"`,
          },
        },
      ],
      maxTokens: 200,
    });
    if (result.content.type !== "text") return undefined;
    const parsed = classificationSchema.safeParse(extractJson(result.content.text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Client hasn't declared the sampling capability (or the request
    // otherwise failed) — the caller falls back to treating this as a task.
    return undefined;
  }
}

function defaultDueDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function registerCaptureTools(server: McpServer, notify: NotifyFn, householdId: string): void {
  server.registerTool(
    "capture_note",
    {
      description:
        "Capture one freeform sentence a household member might say — 'we're almost out of coffee and I need to " +
        "pick up dry cleaning by Friday' — without the caller needing to know which tool handles it. Uses MCP " +
        "sampling to classify the note as a shopping-list item, a task (with a due date if one was mentioned), or " +
        "an expense to log, then routes it into the matching existing tool's own storage. Prefer this over " +
        "add_task/reorder_item/add_expense directly when the input is an unstructured sentence rather than " +
        "already-separated fields. Falls back to treating the whole sentence as a task if the connected client " +
        "doesn't support sampling.",
      inputSchema: {
        text: z.string().min(1).describe("One freeform sentence to capture and route, verbatim."),
      },
      outputSchema: {
        routedTo: z.enum(["shopping", "task", "expense"]),
        usedSampling: z.boolean(),
        itemId: z.string().optional(),
        itemName: z.string().optional(),
        taskId: z.string().optional(),
        title: z.string().optional(),
        dueDate: z.string().optional(),
        assignee: z.string().optional(),
        expenseId: z.string().optional(),
        description: z.string().optional(),
        amount: z.number().optional(),
        category: z.string().optional(),
      },
      annotations: { title: "Capture note", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ text }) => {
      const sampled = await classifyNote(server, text);
      const usedSampling = sampled !== undefined;
      const classification: Classification = sampled ?? { type: "task", title: text.trim() };

      if (classification.type === "shopping") {
        const itemName = classification.item?.trim() || text.trim();
        const item = reportLowStock(householdId, itemName);
        await notify(RESOURCE_URIS.lowStock);
        await logEvent(server, "info", "Note captured as shopping item", { itemId: item.id, itemName: item.name, usedSampling });
        return {
          content: [{ type: "text", text: `Got it — added "${item.name}" to the shopping/low-stock list.` }],
          structuredContent: { routedTo: "shopping", usedSampling, itemId: item.id, itemName: item.name },
        };
      }

      if (classification.type === "expense" && typeof classification.amount === "number" && classification.amount > 0) {
        const description = classification.description?.trim() || text.trim();
        const category = classification.category?.trim() || "general";
        const expense = addExpense(householdId, description, classification.amount, category);
        const warning = await applyExpenseFollowUps(server, notify, householdId, expense);
        await logEvent(server, "info", "Note captured as expense", {
          expenseId: expense.id,
          amount: expense.amount,
          category: expense.category,
          usedSampling,
        });
        return {
          content: [
            { type: "text", text: `Logged ${expense.amount.toFixed(2)} for "${expense.description}" under ${expense.category}.${warning}` },
          ],
          structuredContent: {
            routedTo: "expense",
            usedSampling,
            expenseId: expense.id,
            description: expense.description,
            amount: expense.amount,
            category: expense.category,
          },
        };
      }

      // Either genuinely classified as a task, or classified as an expense
      // with no usable amount — either way, don't lose the note: add it as a
      // task rather than silently dropping it.
      const isUnbilledExpense = classification.type === "expense";
      const title = isUnbilledExpense
        ? `Log expense: ${classification.description?.trim() || text.trim()}`
        : classification.title?.trim() || text.trim();
      const dueDate =
        !isUnbilledExpense && classification.dueDate && DATE_PATTERN.test(classification.dueDate)
          ? classification.dueDate
          : defaultDueDate();
      const assignee = !isUnbilledExpense ? classification.assignee?.trim() || undefined : undefined;

      const task = addTask(householdId, title, dueDate, assignee);
      await notify(RESOURCE_URIS.upcomingTasks);
      await logEvent(server, "info", isUnbilledExpense ? "Note captured as task (expense had no amount)" : "Note captured as task", {
        taskId: task.id,
        usedSampling,
      });
      return {
        content: [
          {
            type: "text",
            text: isUnbilledExpense
              ? `Couldn't tell how much that cost, so I added a task to log it manually: "${task.title}" due ${task.dueDate}.`
              : `Added a task: "${task.title}" due ${task.dueDate}${task.assignee ? ` for ${task.assignee}` : ""}.`,
          },
        ],
        structuredContent: {
          routedTo: "task",
          usedSampling,
          taskId: task.id,
          title: task.title,
          dueDate: task.dueDate,
          assignee: task.assignee,
        },
      };
    }
  );
}
