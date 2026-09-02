/**
 * Minimal per-game pub/sub used to push live updates to connected
 * `GET /games/:id/stream` (Server-Sent Events) clients the moment new
 * commentary is generated, instead of making every Fire TV overlay poll
 * `GET /games/:id/commentary` on a timer. Kept as a tiny in-process
 * EventEmitter registry (one emitter per game, created lazily) rather than
 * pulling in a message-broker dependency — this is a single-process demo
 * service, and the interface (`publish`/`subscribe`) is the seam a real
 * deployment would swap for Redis pub/sub or a WebSocket fan-out if it ever
 * needed to run behind more than one process.
 */
import { EventEmitter } from "node:events";

export interface StreamEvent {
  type: "commentary";
  commentary: unknown;
  state: unknown;
}

const emitters = new Map<string, EventEmitter>();

function getEmitter(gameId: string): EventEmitter {
  let emitter = emitters.get(gameId);
  if (!emitter) {
    emitter = new EventEmitter();
    // A popular game could have many simultaneous overlay viewers streaming
    // at once; the default 10-listener cap would otherwise log warnings.
    emitter.setMaxListeners(0);
    emitters.set(gameId, emitter);
  }
  return emitter;
}

/** Publishes a payload to every current subscriber of a game's stream. A no-op if nobody is listening. */
export function publish(gameId: string, payload: StreamEvent): void {
  emitters.get(gameId)?.emit("message", payload);
}

/** Subscribes to a game's stream. Returns an unsubscribe function — call it when the client disconnects. */
export function subscribe(gameId: string, listener: (payload: StreamEvent) => void): () => void {
  const emitter = getEmitter(gameId);
  emitter.on("message", listener);
  return () => {
    emitter.off("message", listener);
  };
}
