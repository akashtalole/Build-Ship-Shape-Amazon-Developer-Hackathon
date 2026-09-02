import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addTask, listUpcomingTasks, markTaskDone, openTaskCounts, suggestAssignee } from "../store.js";
import { RESOURCE_URIS, type NotifyFn } from "../resources.js";

const taskShape = {
  id: z.string(),
  title: z.string(),
  dueDate: z.string(),
  assignee: z.string().optional(),
  done: z.boolean(),
};

export function registerTaskTools(server: McpServer, notify: NotifyFn): void {
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
      const tasks = listUpcomingTasks(withinDays ?? 7);
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
      const task = addTask(title, dueDate, assignee);
      await notify(RESOURCE_URIS.upcomingTasks);
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
    "mark_task_done",
    {
      description: "Mark a household task as completed by its task ID (from list_upcoming_tasks).",
      inputSchema: {
        taskId: z.string().describe("The task ID to mark complete."),
      },
      annotations: { title: "Mark task done", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId }) => {
      const task = markTaskDone(taskId);
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
      const suggestion = suggestAssignee();
      const counts = openTaskCounts()
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
      const tasks = listUpcomingTasks(30);
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
