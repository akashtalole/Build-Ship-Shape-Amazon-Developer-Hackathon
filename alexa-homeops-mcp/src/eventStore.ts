import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface StoredEvent {
  streamId: string;
  message: JSONRPCMessage;
}

/**
 * In-memory EventStore for Streamable HTTP resumability. If a client's SSE
 * connection drops mid-conversation (a flaky network, an app backgrounded),
 * it can reconnect with the `Last-Event-ID` header and this replays every
 * message — a task-completion notification, a budget alert — it would
 * otherwise have silently lost. A real multi-instance deployment would back
 * this with Redis or a database instead of process memory, so replay
 * survives a server restart, not just a dropped connection.
 */
export class InMemoryEventStore implements EventStore {
  private events = new Map<string, StoredEvent>();
  private sequence = 0;

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    // Zero-padded sequence numbers sort lexicographically in event-id order,
    // which replayEventsAfter relies on to find "everything after X".
    const eventId = `${streamId}:${(this.sequence++).toString().padStart(12, "0")}`;
    this.events.set(eventId, { streamId, message });
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    const streamId = lastEventId.split(":")[0];
    if (!streamId) return "";

    const ordered = [...this.events.entries()]
      .filter(([, event]) => event.streamId === streamId)
      .sort(([a], [b]) => a.localeCompare(b));

    let pastLastEvent = false;
    for (const [eventId, { message }] of ordered) {
      if (eventId === lastEventId) {
        pastLastEvent = true;
        continue;
      }
      if (pastLastEvent) {
        await send(eventId, message);
      }
    }
    return streamId;
  }
}
