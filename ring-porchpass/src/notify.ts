import { randomUUID } from "node:crypto";
import type { Notification } from "./types.js";

/**
 * Notification sender, isolated behind an interface for the same reason as
 * RingClient: a real deployment swaps this for Twilio (SMS) and/or a push
 * provider without touching the access-control logic that calls it.
 */
export interface Notifier {
  send(to: Notification["to"], channel: Notification["channel"], message: string): Promise<Notification>;
  history(): Notification[];
}

export class LoggingNotifier implements Notifier {
  private sent: Notification[] = [];

  async send(to: Notification["to"], channel: Notification["channel"], message: string): Promise<Notification> {
    const notification: Notification = { id: randomUUID(), to, channel, message, sentAt: new Date().toISOString() };
    this.sent.push(notification);
    // Stands in for an actual SMS/push send; logging keeps the demo and
    // tests fully self-contained with no external account required.
    console.log(`[notify:${channel}->${to}] ${message}`);
    return notification;
  }

  history(): Notification[] {
    return this.sent;
  }
}
