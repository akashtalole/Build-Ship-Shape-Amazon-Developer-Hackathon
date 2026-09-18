import { randomUUID } from "node:crypto";
import type { Notification } from "./types.js";

/**
 * Notification sender, isolated behind an interface for the same reason as
 * RingClient: a real deployment swaps this for Twilio (SMS) and/or a push
 * provider without touching the access-control logic that calls it.
 */
export interface Notifier {
  /**
   * `recipient` is the actual destination address for this send (e.g. a
   * visitor's phone number) when one applies. Call sites that hold an
   * encrypted PII field (see `crypto.ts`) decrypt it right here, at the one
   * moment it's genuinely needed, rather than ever keeping a plaintext copy
   * around on the `Pass` object itself.
   */
  send(to: Notification["to"], channel: Notification["channel"], message: string, recipient?: string): Promise<Notification>;
  history(): Notification[];
}

export class LoggingNotifier implements Notifier {
  private sent: Notification[] = [];

  async send(to: Notification["to"], channel: Notification["channel"], message: string, recipient?: string): Promise<Notification> {
    const notification: Notification = { id: randomUUID(), to, channel, message, sentAt: new Date().toISOString(), recipient };
    this.sent.push(notification);
    // Stands in for an actual SMS/push send; logging keeps the demo and
    // tests fully self-contained with no external account required.
    console.log(`[notify:${channel}->${to}${recipient ? ` (${recipient})` : ""}] ${message}`);
    return notification;
  }

  history(): Notification[] {
    return this.sent;
  }
}
