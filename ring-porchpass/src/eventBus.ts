import { EventEmitter } from "node:events";
import type { Pass, Visit } from "./types.js";

/**
 * The events pushed to homeowner dashboards over `GET /events/stream`
 * (Server-Sent Events). Additive real-time layer on top of the existing
 * `GET /visits` polling-friendly audit trail — this doesn't replace it.
 */
export type PorchPassEvent =
  | { type: "pass_issued"; at: string; pass: Pass }
  | { type: "visit_checkin"; at: string; pass: Pass; visit: Visit }
  | { type: "visit_checkout"; at: string; pass: Pass; visit: Visit }
  | { type: "pass_revoked"; at: string; pass: Pass }
  | { type: "pass_expired"; at: string; pass: Pass };

const INTERNAL_EVENT = "porchpass_event";

class PorchPassEventBus extends EventEmitter {
  constructor() {
    super();
    // Each open SSE connection holds one listener for as long as the
    // dashboard tab is open — well beyond Node's default warn-at-10 cap in
    // any real multi-viewer household. Raised, not disabled, so a genuine
    // leak (a listener that never gets cleaned up on `req.close`) still
    // eventually surfaces.
    this.setMaxListeners(100);
  }

  publish(event: PorchPassEvent): void {
    this.emit(INTERNAL_EVENT, event);
  }

  subscribe(listener: (event: PorchPassEvent) => void): () => void {
    this.on(INTERNAL_EVENT, listener);
    return () => this.off(INTERNAL_EVENT, listener);
  }
}

export const eventBus = new PorchPassEventBus();
