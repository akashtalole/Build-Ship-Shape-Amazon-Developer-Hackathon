import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addTask, listUpcomingTasks, markTaskDone } from "../store.js";

export function registerTaskTools(server: McpServer): void {
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
    },
    async ({ withinDays }) => {
      const tasks = listUpcomingTasks(withinDays ?? 7);
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: `Nothing due in the next ${withinDays ?? 7} day(s).` }] };
      }
      const lines = tasks.map(
        (t) => `- [${t.dueDate}] ${t.title}${t.assignee ? ` (assigned to ${t.assignee})` : ""}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "add_task",
    {
      description: "Add a new household task with a due date and optional assignee.",
      inputSchema: {
        title: z.string().min(1).describe("Short description of the task."),
        dueDate: z.string().describe("Due date in YYYY-MM-DD format."),
        assignee: z.string().optional().describe("Household member responsible, if known."),
      },
    },
    async ({ title, dueDate, assignee }) => {
      const task = addTask(title, dueDate, assignee);
      return {
        content: [
          {
            type: "text",
            text: `Added "${task.title}" due ${task.dueDate}${assignee ? ` for ${assignee}` : ""}.`,
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
    },
    async ({ taskId }) => {
      const task = markTaskDone(taskId);
      if (!task) {
        return { content: [{ type: "text", text: `No task found with ID ${taskId}.` }], isError: true };
      }
      return { content: [{ type: "text", text: `Marked "${task.title}" as done.` }] };
    }
  );
}
