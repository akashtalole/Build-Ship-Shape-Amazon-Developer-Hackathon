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

/**
 * The at-rest representation of an AES-256-GCM-encrypted string field — see
 * `crypto.ts`. `iv` and `authTag` are per-encryption values (a fresh random
 * IV every time `encryptField` runs) required to decrypt `ciphertext`; none
 * of the three alone (nor all three together, without the server's key)
 * reveals the plaintext.
 */
export interface EncryptedField {
  iv: string; // hex, 12 random bytes (96-bit GCM-standard IV)
  authTag: string; // hex, GCM authentication tag
  ciphertext: string; // hex
}

export interface Pass {
  id: string;
  checkinToken: string; // opaque token embedded in the visitor's magic link
  visitorName: string;
  // Encrypted at rest (AES-256-GCM) — see crypto.ts. Never held as plaintext
  // on the Pass object; decrypted only at the point it's actually needed
  // (sending the visitor's SMS) via `passService.decryptVisitorPhone`. API
  // responses expose a masked `visitorPhone` (see `passService.serializePass`)
  // rather than this field directly.
  visitorPhoneEnc: EncryptedField;
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
  deviceIds?: string[]; // Ring device(s) this pass's check-in correlates against; defaults to [FRONT_DOOR_DEVICE_ID] when omitted, for backward compatibility
  extension?: PassExtension; // grace-period extension request/decision state — see passService.ts's request/decide-extension flow
}

/**
 * Tracks a homeowner-side registered Ring device. Devices need no separate
 * setup step to be usable — the first pass or Ring event that references a
 * `deviceId` implicitly registers it (see `devices.ts`) — `POST /devices`
 * is available for a homeowner who wants to name one ahead of time.
 */
export interface Device {
  id: string;
  name: string;
  registeredAt: string; // ISO timestamp
  registeredVia: "explicit" | "pass" | "event"; // how this device first came to be known to PorchPass
}

/**
 * State machine for a grace-period check-in extension: `undefined` (never
 * requested) -> "pending" (visitor asked, homeowner not yet responded) ->
 * "approved" | "denied" (homeowner's decision, final). An approved
 * extension is usable for exactly one more check-in, within a short window
 * after `decidedAt` (see `EXTENSION_USABLE_WINDOW_MS` in `passService.ts`);
 * `usedAt` marks that single use as spent so it can't be replayed.
 */
export interface PassExtension {
  status: "pending" | "approved" | "denied";
  requestedAt: string; // ISO timestamp
  decidedAt?: string; // ISO timestamp — set once the homeowner approves or denies
  usedAt?: string; // ISO timestamp — set once an approved extension is consumed by a check-in
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

/**
 * A single arrival, and (once the visitor taps "I'm leaving") its paired
 * departure. `checkedOutAt`/`durationMs` are both unset from the moment of
 * arrival until `POST /checkin/:token/checkout` closes this visit out — see
 * `passService.checkOut`. A visit with `checkedOutAt` unset is "still
 * on-site" (see `passService.listVisitsWithStatus`); `durationMs` is
 * computed once, at checkout time, from `checkedOutAt - checkedInAt`, rather
 * than being recomputed live on every read.
 */
export interface Visit {
  id: string;
  passId: string;
  visitorName: string;
  checkedInAt: string; // ISO timestamp — the arrival
  matchedEvent?: RingEvent; // the Ring event correlated with this check-in, if any
  checkedOutAt?: string; // ISO timestamp — the departure, once it happens
  durationMs?: number; // checkedOutAt - checkedInAt, computed once at checkout
}

export interface Notification {
  id: string;
  to: "homeowner" | "visitor";
  channel: "sms" | "push";
  message: string;
  sentAt: string;
  // The real destination address (e.g. a decrypted phone number) this send
  // actually went to, when one applies — see `crypto.ts`'s framing on
  // "decrypted only when actually needed": this is that one moment for an
  // SMS to a visitor. Absent for sends that don't target a specific address
  // (e.g. "homeowner" push notifications in this demo, which have no
  // registered device token to speak of).
  recipient?: string;
}
