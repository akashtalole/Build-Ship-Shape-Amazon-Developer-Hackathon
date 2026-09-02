export type PassStatus = "active" | "used_up" | "expired" | "revoked";

export interface Pass {
  id: string;
  checkinToken: string; // opaque token embedded in the visitor's magic link
  visitorName: string;
  visitorPhone: string;
  issuedAt: string; // ISO timestamp
  validFrom: string; // ISO timestamp
  validUntil: string; // ISO timestamp
  maxUses: number;
  useCount: number;
  status: PassStatus;
  note?: string; // e.g. "dog walker", "HVAC repair"
}

export type RingEventType = "ding" | "motion";

export interface RingEvent {
  id: string;
  deviceId: string;
  deviceName: string;
  type: RingEventType;
  occurredAt: string; // ISO timestamp
  snapshotUrl: string;
}

export interface Visit {
  id: string;
  passId: string;
  visitorName: string;
  checkedInAt: string; // ISO timestamp
  matchedEvent?: RingEvent; // the Ring event correlated with this check-in, if any
}

export interface Notification {
  id: string;
  to: "homeowner" | "visitor";
  channel: "sms" | "push";
  message: string;
  sentAt: string;
}
