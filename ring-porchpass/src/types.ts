export type PassStatus = "active" | "used_up" | "expired" | "revoked";

/**
 * A recurring access window, e.g. "every Tue/Thu, 13:00-15:00" for a weekly
 * dog walker. `daysOfWeek` uses JS's `Date#getUTCDay()` convention
 * (0=Sunday..6=Saturday). `startTime`/`endTime` are "HH:MM" 24-hour clock
 * values interpreted in UTC — this demo keeps everything in UTC rather than
 * modeling per-household timezones, but a real deployment would store an IANA
 * timezone alongside the rule and convert before comparing. `startTime` may
 * be greater than `endTime` to express a window that crosses midnight (e.g.
 * "22:00" -> "02:00" for an overnight dog-sitter).
 *
 * `validFrom`/`validUntil` on the pass still apply as the *outer* bounds for
 * a recurring pass (e.g. "this recurring schedule is valid for the next 90
 * days") — the recurrence rule narrows validity further, within each day.
 */
export interface RecurrenceRule {
  daysOfWeek: number[]; // 0=Sunday..6=Saturday (UTC)
  startTime: string; // "HH:MM", UTC, 24h clock
  endTime: string; // "HH:MM", UTC, 24h clock
}

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
  recurrence?: RecurrenceRule; // when set, validity within [validFrom, validUntil] is further narrowed to matching day/time windows
  allowQuietHours?: boolean; // opt out of household quiet-hours enforcement for this specific pass
  idempotencyKey?: string; // the key this pass was issued under, if any (for debugging/audit)
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
