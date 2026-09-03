import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addTask, importTasks, listUpcomingTasks, markTaskDone, openTaskCounts, suggestAssignee } from "../store.js";
import { RESOURCE_URIS, type NotifyFn } from "../resources.js";
import { logEvent } from "../logging.js";

const taskShape = {
  id: z.string(),
  title: z.string(),
  dueDate: z.string(),
  assignee: z.string().optional(),
  done: z.boolean(),
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function registerTaskTools(server: McpServer, notify: NotifyFn, householdId: string): void {
  server.registerTool(
    "list_upcoming_tasks",
    {
      description:
        "List household tasks that are due soon. Use this to answer questions like " +
        "'what's due this week' or 'what's on the household list today'.",
      inputSchema: {
        withinDays: z
          .number()
          .int()
          .min(0)
          .max(30)
          .default(7)
          .describe("Return tasks due within this many days from today (default 7)."),
      },
      // Structured output lets a client render its own UI (a list, a card)
      // from `structuredContent` instead of re-parsing the text summary.
      outputSchema: { tasks: z.array(z.object(taskShape)) },
      annotations: { title: "List upcoming tasks", readOnlyHint: true, openWorldHint: false },
    },
    async ({ withinDays }) => {
      const tasks = listUpcomingTasks(householdId, withinDays ?? 7);
      const text =
        tasks.length === 0
          ? `Nothing due in the next ${withinDays ?? 7} day(s).`
          : tasks.map((t) => `- [${t.dueDate}] ${t.title}${t.assignee ? ` (assigned to ${t.assignee})` : ""}`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { tasks } };
    }
  );

  server.registerTool(
    "add_task",
    {
      description:
        "Add a new household task with a due date. If no assignee is given, one is picked " +
        "automatically using fair chore rotation (whoever currently has the fewest open tasks).",
      inputSchema: {
        title: z.string().min(1).describe("Short description of the task."),
        dueDate: z.string().describe("Due date in YYYY-MM-DD format."),
        assignee: z
          .string()
          .optional()
          .describe("Household member responsible. Omit to auto-assign fairly."),
      },
      annotations: { title: "Add task", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, dueDate, assignee }) => {
      const wasAutoAssigned = !assignee;
      const task = addTask(householdId, title, dueDate, assignee);
      await notify(RESOURCE_URIS.upcomingTasks);
      await logEvent(server, "info", "Task added", {
        taskId: task.id,
        title: task.title,
        dueDate: task.dueDate,
        assignee: task.assignee,
        autoAssigned: wasAutoAssigned,
      });
      return {
        content: [
          {
            type: "text",
            text: `Added "${task.title}" due ${task.dueDate} for ${task.assignee}${
              wasAutoAssigned ? " (auto-assigned by workload)" : ""
            }.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "import_tasks",
    {
      description:
        "Bulk-add several household tasks in one call, e.g. 'add my whole week's chores at once'. " +
        "Each item is validated independently — a malformed item (missing title, or a due date not in " +
        "YYYY-MM-DD format) is reported as rejected without blocking the valid items in the same batch. " +
        "Prefer this over repeated add_task calls when the user hands you a list.",
      inputSchema: {
        items: z
          .array(
            z
              .object({
                title: z.unknown().optional().describe("Short description of the task."),
                dueDate: z.unknown().optional().describe("Due date in YYYY-MM-DD format."),
                assignee: z.unknown().optional().describe("Household member responsible. Omit to auto-assign fairly."),
              })
              .passthrough()
          )
          .min(1)
          .max(100)
          .describe("The tasks to add, one object per task."),
      },
      outputSchema: {
        results: z.array(
          z.object({
            index: z.number(),
            status: z.enum(["added", "rejected"]),
            title: z.string().optional(),
            taskId: z.string().optional(),
            dueDate: z.string().optional(),
            assignee: z.string().optional(),
            reason: z.string().optional(),
          })
        ),
        addedCount: z.number(),
        rejectedCount: z.number(),
      },
      annotations: { title: "Import tasks", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ items }) => {
      type ItemResult = {
        index: number;
        status: "added" | "rejected";
        title?: string;
        taskId?: string;
        dueDate?: string;
        assignee?: string;
        reason?: string;
      };

      const results: ItemResult[] = [];
      const toAdd: { index: number; title: string; dueDate: string; assignee?: string }[] = [];

      items.forEach((raw, index) => {
        const title = typeof raw.title === "string" ? raw.title.trim() : "";
        const dueDate = typeof raw.dueDate === "string" ? raw.dueDate.trim() : "";
        const assignee = typeof raw.assignee === "string" && raw.assignee.trim() ? raw.assignee.trim() : undefined;

        if (!title) {
          results.push({ index, status: "rejected", reason: "Missing or empty title." });
          return;
        }
        if (!DATE_PATTERN.test(dueDate)) {
          results.push({ index, status: "rejected", title, reason: `dueDate must be YYYY-MM-DD, got ${JSON.stringify(raw.dueDate)}.` });
          return;
        }
        toAdd.push({ index, title, dueDate, assignee });
      });

      // One store write and one resource notification for the whole batch,
      // not one per item — that's the point of a bulk-import tool.
      const created = importTasks(
        householdId,
        toAdd.map(({ title, dueDate, assignee }) => ({ title, dueDate, assignee }))
      );

      created.forEach((task, i) => {
        const { index } = toAdd[i];
        results.push({ index, status: "added", title: task.title, taskId: task.id, dueDate: task.dueDate, assignee: task.assignee });
      });
      results.sort((a, b) => a.index - b.index);

      const addedCount = created.length;
      const rejectedCount = results.length - addedCount;

      if (addedCount > 0) {
        await notify(RESOURCE_URIS.upcomingTasks);
      }
      await logEvent(server, rejectedCount > 0 ? "warning" : "info", "Bulk task import completed", {
        addedCount,
        rejectedCount,
        totalRequested: items.length,
      });

      const lines = results.map((r) =>
        r.status === "added"
          ? `- [added] "${r.title}" due ${r.dueDate} for ${r.assignee}`
          : `- [rejected] item ${r.index}${r.title ? ` ("${r.title}")` : ""}: ${r.reason}`
      );
      const text = `Imported ${addedCount}/${items.length} task(s).\n${lines.join("\n")}`;

      return { content: [{ type: "text", text }], structuredContent: { results, addedCount, rejectedCount } };
    }
  );

  server.registerTool(
    "mark_task_done",
    {
      description: "Mark a household task as completed by its task ID (from list_upcoming_tasks).",
      inputSchema: {
        taskId: z.string().describe("The task ID to mark complete."),
      },
      annotations: { title: "Mark task done", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId }) => {
      const task = markTaskDone(householdId, taskId);
      if (!task) {
        return { content: [{ type: "text", text: `No task found with ID ${taskId}.` }], isError: true };
      }
      await notify(RESOURCE_URIS.upcomingTasks);
      return { content: [{ type: "text", text: `Marked "${task.title}" as done.` }] };
    }
  );

  server.registerTool(
    "suggest_assignee",
    {
      description:
        "Suggest which household member should take the next chore, based on who currently " +
        "has the fewest open tasks. Use this before assigning a new task to keep chores balanced.",
      inputSchema: {},
      annotations: { title: "Suggest assignee", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const suggestion = suggestAssignee(householdId);
      const counts = openTaskCounts(householdId)
        .map((c) => `${c.member}: ${c.openTasks} open`)
        .join(", ");
      return {
        content: [{ type: "text", text: `Suggest ${suggestion} (current workload — ${counts}).` }],
      };
    }
  );

  server.registerTool(
    "sync_household_calendar",
    {
      description:
        "Sync upcoming household tasks to the shared family calendar. This can take a few " +
        "seconds; the server reports progress per task as it syncs, if the client asked for it.",
      inputSchema: {},
      annotations: { title: "Sync calendar", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_args, extra) => {
      const tasks = listUpcomingTasks(householdId, 30);
      const progressToken = extra._meta?.progressToken;

      for (let i = 0; i < tasks.length; i++) {
        // Simulate the latency of a real calendar API call per task.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: i + 1,
              total: tasks.length,
              message: `Synced "${tasks[i].title}" (${i + 1}/${tasks.length})`,
            },
          });
        }
      }

      return {
        content: [{ type: "text", text: `Synced ${tasks.length} task(s) to the shared calendar.` }],
      };
    }
  );
}
