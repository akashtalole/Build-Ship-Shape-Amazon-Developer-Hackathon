import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllowanceBalances, recordAllowancePayout, setTaskReward } from "../store.js";
import { logEvent } from "../logging.js";

/**
 * Chore-to-allowance ledger: three tools that sit on top of the existing
 * fair-chore-assignment system (add_task/mark_task_done) rather than
 * building a second, parallel task concept. A task earns its assignee money
 * only if someone opts it in via set_task_reward; mark_task_done (in
 * tasks.ts) is what actually credits the balance the moment that task is
 * completed, since that's the one place "this chore just got done" is
 * already known. record_allowance_payout is the "settle up" step — it never
 * mutates a task, only the running per-member balance.
 */
export function registerAllowanceTools(server: McpServer, householdId: string): void {
  server.registerTool(
    "set_task_reward",
    {
      description:
        "Set (or clear, with amount 0) how much an existing task is worth toward its assignee's allowance once " +
        "it's marked done — e.g. 'the trash chore is worth $2'. Use list_upcoming_tasks first to find the task ID. " +
        "The reward is only ever credited once, at the moment mark_task_done completes this specific task.",
      inputSchema: {
        taskId: z.string().describe("The task ID to attach a reward to (from list_upcoming_tasks)."),
        amount: z.number().nonnegative().describe("Allowance amount awarded to the assignee when this task is completed."),
      },
      annotations: { title: "Set task reward", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId, amount }) => {
      const task = setTaskReward(householdId, taskId, amount);
      if (!task) {
        return { content: [{ type: "text", text: `No task found with ID ${taskId}.` }], isError: true };
      }
      if (!task.assignee) {
        return {
          content: [
            {
              type: "text",
              text: `"${task.title}" has no assignee yet, so a reward of ${amount.toFixed(2)} was set but won't have anyone to pay out to until one is assigned.`,
            },
          ],
        };
      }
      await logEvent(server, "info", "Task reward set", { taskId: task.id, title: task.title, assignee: task.assignee, amount });
      return {
        content: [
          {
            type: "text",
            text: `"${task.title}" is now worth ${amount.toFixed(2)} to ${task.assignee} once marked done.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_allowance_balance",
    {
      description:
        "Check a household member's running allowance balance earned from completed chores, or every member's " +
        "balance at once if none is given.",
      inputSchema: {
        member: z.string().optional().describe("Household member to check. Omit to list every member's balance."),
      },
      outputSchema: { balances: z.array(z.object({ member: z.string(), balance: z.number() })) },
      annotations: { title: "Get allowance balance", readOnlyHint: true, openWorldHint: false },
    },
    async ({ member }) => {
      const all = getAllowanceBalances(householdId);
      const balances = member
        ? [{ member, balance: all[member] ?? 0 }]
        : Object.entries(all).map(([m, balance]) => ({ member: m, balance }));
      const text = balances.map((b) => `- ${b.member}: ${b.balance.toFixed(2)}`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { balances } };
    }
  );

  server.registerTool(
    "record_allowance_payout",
    {
      description:
        "Record that a household member was paid their allowance, reducing (or, if no amount is given, fully " +
        "zeroing) their running balance. Use get_allowance_balance first to see what's owed.",
      inputSchema: {
        member: z.string().min(1).describe("Household member being paid out."),
        amount: z
          .number()
          .positive()
          .optional()
          .describe("Amount paid. Omit to pay out (and zero) the member's entire current balance."),
      },
      outputSchema: { member: z.string(), paidOut: z.number(), remainingBalance: z.number() },
      annotations: { title: "Record allowance payout", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ member, amount }) => {
      const result = recordAllowancePayout(householdId, member, amount);
      await logEvent(server, "info", "Allowance paid out", { ...result });
      return {
        content: [
          {
            type: "text",
            text: `Paid ${result.paidOut.toFixed(2)} to ${result.member}. Remaining balance: ${result.remainingBalance.toFixed(2)}.`,
          },
        ],
        structuredContent: { ...result },
      };
    }
  );
}
