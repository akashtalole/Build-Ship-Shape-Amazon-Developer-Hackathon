import { randomUUID } from "node:crypto";
import type { RingEvent, RingEventType } from "./types.js";

/**
 * The seam between PorchPass's access-control logic and Ring itself. A real
 * deployment would implement this against Ring's OAuth-authenticated device
 * API (per the `ring-api-helloworld` starter sample) to subscribe to
 * doorbell/motion webhooks and fetch snapshot URLs. The hackathon rules
 * explicitly allow "APIs, SDKs, simulators, or devices" — this ships a
 * simulator so the access-control logic is fully demoable and testable
 * without Ring hardware or partner API credentials, while keeping the real
 * integration point isolated to this one file.
 */
export interface RingClient {
  /** Fetches recent doorbell/motion events for a device, newest first. */
  getRecentEvents(deviceId: string, sinceMs: number): Promise<RingEvent[]>;
  /** Simulates (or, in a real client, receives via webhook) a new event. */
  emitEvent(deviceId: string, type: RingEventType): Promise<RingEvent>;
}

/**
 * In-memory Ring simulator. `emitEvent` stands in for Ring's webhook POST
 * to our server; a real integration would remove `emitEvent` entirely and
 * instead have an Express route receive Ring's actual webhook payload and
 * append it to the same event log.
 */
export class SimulatedRingClient implements RingClient {
  private events: RingEvent[] = [];

  async emitEvent(deviceId: string, type: RingEventType): Promise<RingEvent> {
    const event: RingEvent = {
      id: randomUUID(),
      deviceId,
      deviceName: deviceId === "front-door" ? "Front Door" : deviceId,
      type,
      occurredAt: new Date().toISOString(),
      // A real client would return Ring's actual signed snapshot/clip URL.
      snapshotUrl: `https://simulated-ring-cdn.example/snapshots/${randomUUID()}.jpg`,
    };
    this.events.unshift(event);
    return event;
  }

  async getRecentEvents(deviceId: string, sinceMs: number): Promise<RingEvent[]> {
    const cutoff = Date.now() - sinceMs;
    return this.events.filter((e) => e.deviceId === deviceId && new Date(e.occurredAt).getTime() >= cutoff);
  }
}
