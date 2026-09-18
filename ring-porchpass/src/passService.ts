import { randomUUID } from "node:crypto";
import type { Pass, PassExtension, RecurrenceRule, Visit } from "./types.js";
import {
  addVisit,
  getPassById,
  getPassByToken,
  getPassIdByIdempotencyKey,
  listPasses,
  listVisits,
  rememberIdempotencyKey,
  savePass,
} from "./store.js";
import type { RingClient } from "./ringClient.js";
import type { Notifier } from "./notify.js";
import { isWithinRecurrence } from "./recurrence.js";
import { getSettings, isWithinQuietHours } from "./settings.js";
import { checkAndRecordAttempt } from "./rateLimiter.js";
import { eventBus } from "./eventBus.js";
import { FRONT_DOOR_DEVICE_ID, registerDevice } from "./devices.js";

// How far back to look for a Ring event to correlate with a check-in — a
// visitor tapping the link and the doorbell/motion event should land within
// a few minutes of each other in any real-world flow.
const EVENT_CORRELATION_WINDOW_MS = 5 * 60 * 1000;

// A visitor whose pass expired within this window of "now" may request a
// short grace-period extension instead of being flatly turned away — long
// enough to cover someone tapping the link moments after their window
// closed, short enough that it isn't effectively a second, unbounded pass.
export const GRACE_REQUEST_WINDOW_MS = 30 * 60 * 1000;
// Once the homeowner approves a request, the visitor has this long from the
// approval to actually use it — deliberately short, since it's meant to
// cover "I'm literally standing at the door right now", not a new pass.
export const EXTENSION_USABLE_WINDOW_MS = 15 * 60 * 1000;

export interface IssuePassInput {
  visitorName: string;
  visitorPhone: string;
  validFrom?: string; // defaults to now
  validUntil: string; // for a recurring pass, the outer bound the whole schedule expires by
  maxUses?: number; // defaults to 1 (single-use)
  note?: string;
  baseUrl: string; // used to build the visitor's magic link
  recurrence?: RecurrenceRule; // e.g. the weekly dog walker's Tue/Thu 13:00-15:00 window
  allowQuietHours?: boolean; // let this specific pass check in during household quiet hours
  idempotencyKey?: string; // retrying issuance with the same key returns the original pass, unchanged
  deviceIds?: string[]; // which registered Ring device(s) this pass's check-in should correlate against; defaults to [FRONT_DOOR_DEVICE_ID]
}

export async function issuePass(input: IssuePassInput, notifier: Notifier): Promise<Pass> {
  // Idempotent replay: a client that retried a request it wasn't sure went
  // through (timeout, dropped connection) gets back the exact same pass —
  // no second pass, no second "you have access" SMS to the visitor.
  if (input.idempotencyKey) {
    const existingId = getPassIdByIdempotencyKey(input.idempotencyKey);
    if (existingId) {
      const existing = getPassById(existingId);
      if (existing) return existing;
    }
  }

  // A pass that names a device it its `deviceIds` is the other place (besides
  // a Ring event arriving) a device can become registered — see `devices.ts`.
  if (input.deviceIds) {
    for (const deviceId of input.deviceIds) registerDevice(deviceId, { via: "pass" });
  }

  const now = new Date();
  const pass: Pass = {
    id: randomUUID(),
    checkinToken: randomUUID(),
    visitorName: input.visitorName,
    visitorPhone: input.visitorPhone,
    issuedAt: now.toISOString(),
    validFrom: input.validFrom ?? now.toISOString(),
    validUntil: input.validUntil,
    maxUses: input.maxUses ?? 1,
    useCount: 0,
    status: "active",
    note: input.note,
    recurrence: input.recurrence,
    allowQuietHours: input.allowQuietHours,
    idempotencyKey: input.idempotencyKey,
    deviceIds: input.deviceIds,
  };
  savePass(pass);
  if (input.idempotencyKey) {
    rememberIdempotencyKey(input.idempotencyKey, pass.id);
  }

  const link = `${input.baseUrl}/checkin/${pass.checkinToken}`;
  await notifier.send(
    "visitor",
    "sms",
    `Hi ${pass.visitorName}, you have access to the house ${formatWindow(pass)}. Tap to let us know you've arrived: ${link}`
  );

  eventBus.publish({ type: "pass_issued", at: now.toISOString(), pass });

  return pass;
}

/** Recomputes status against the current time without mutating a pass that's still genuinely active. */
export function effectiveStatus(pass: Pass, now = new Date()): Pass["status"] {
  if (pass.status === "revoked" || pass.status === "used_up") return pass.status;
  if (now.getTime() > new Date(pass.validUntil).getTime()) return "expired";
  return pass.status;
}

export interface CheckInResult {
  ok: boolean;
  reason?: string;
  pass?: Pass;
  visit?: Visit;
  rateLimited?: boolean;
  // Set on a rejection whose only problem is that the pass *just* expired —
  // the visitor may call `POST /checkin/:token/request-extension` instead of
  // being turned away outright. Never true alongside `ok: true`.
  graceEligible?: boolean;
}

export async function checkIn(token: string, ringClient: RingClient, notifier: Notifier): Promise<CheckInResult> {
  // Rate-limit by the token being attempted, valid or not — brute-forcing a
  // guessed token is exactly the attack this closes off, so an unknown token
  // must count against the limit the same as a real one.
  const rateLimit = checkAndRecordAttempt(token);
  if (!rateLimit.allowed) {
    const retryMinutes = Math.ceil((rateLimit.retryAfterMs ?? 0) / 60000);
    return {
      ok: false,
      rateLimited: true,
      reason: `Too many check-in attempts for this link. Please try again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`,
    };
  }

  const pass = getPassByToken(token);
  if (!pass) {
    return { ok: false, reason: "This access link isn't valid." };
  }

  const now = new Date();
  const status = effectiveStatus(pass, now);
  // Set when an already-approved grace-period extension is what's letting
  // this check-in through, despite the pass otherwise reading as expired —
  // see the "expired" branch just below and `hasUsableApprovedExtension`.
  let usingExtension = false;

  if (status === "expired") {
    const wasAlreadyMarkedExpired = pass.status === "expired";
    pass.status = "expired";
    savePass(pass);
    if (!wasAlreadyMarkedExpired) {
      eventBus.publish({ type: "pass_expired", at: now.toISOString(), pass });
    }
    if (hasUsableApprovedExtension(pass, now)) {
      usingExtension = true;
    } else {
      // Only worth offering an extension if this is the *first* time the
      // visitor is hearing "expired" for this pass — once one has already
      // been requested (pending, approved-but-lapsed, or denied), a repeat
      // rejection shouldn't invite another request.
      const graceEligible = !pass.extension && isWithinGraceWindow(pass, now);
      return { ok: false, reason: "This pass has expired.", pass, graceEligible };
    }
  }
  if (status === "revoked") {
    return { ok: false, reason: "This pass has been revoked.", pass };
  }
  if (status === "used_up") {
    return { ok: false, reason: "This pass has already been used.", pass };
  }
  if (!usingExtension && now.getTime() < new Date(pass.validFrom).getTime()) {
    return { ok: false, reason: "This pass isn't active yet.", pass };
  }

  // Recurring passes narrow validity further within [validFrom, validUntil]:
  // even though the overall schedule is still active, "now" must also fall
  // inside one of the configured day/time windows. Moot once an extension is
  // in play — the whole outer schedule has already ended by definition.
  if (!usingExtension && pass.recurrence && !isWithinRecurrence(pass.recurrence, now)) {
    return {
      ok: false,
      reason: "This pass's recurring schedule doesn't cover the current day/time.",
      pass,
    };
  }

  // Household-level quiet hours override an otherwise-valid pass — including
  // one being let through on a grace-period extension — unless the pass
  // explicitly opted out.
  const settings = getSettings();
  if (settings.quietHours && !pass.allowQuietHours && isWithinQuietHours(settings.quietHours, now)) {
    return {
      ok: false,
      reason: `Check-ins aren't accepted during quiet hours (${settings.quietHours.start}–${settings.quietHours.end} UTC).`,
      pass,
    };
  }

  // Correlate against every device this pass is scoped to (default: just the
  // front door, for backward compatibility with passes issued before
  // multi-device support existed) rather than only ever the front door.
  const deviceIds = pass.deviceIds && pass.deviceIds.length > 0 ? pass.deviceIds : [FRONT_DOOR_DEVICE_ID];
  const eventsByDevice = await Promise.all(deviceIds.map((deviceId) => ringClient.getRecentEvents(deviceId, EVENT_CORRELATION_WINDOW_MS)));
  const recentEvents = eventsByDevice.flat().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const matchedEvent = recentEvents[0]; // newest event across the pass's scoped device(s), if any

  pass.useCount += 1;
  pass.status = pass.useCount >= pass.maxUses ? "used_up" : "active";
  if (usingExtension && pass.extension) {
    pass.extension = { ...pass.extension, usedAt: now.toISOString() };
  }
  savePass(pass);

  const visit: Visit = {
    id: randomUUID(),
    passId: pass.id,
    visitorName: pass.visitorName,
    checkedInAt: now.toISOString(),
    matchedEvent,
  };
  addVisit(visit);

  const clipNote = matchedEvent ? ` See the doorbell snapshot: ${matchedEvent.snapshotUrl}` : "";
  await notifier.send(
    "homeowner",
    "push",
    `${pass.visitorName} (${pass.note ?? "guest"}) just checked in.${clipNote}`
  );

  eventBus.publish({ type: "visit_checkin", at: now.toISOString(), pass, visit });

  return { ok: true, pass, visit };
}

export function revokePass(id: string): Pass | undefined {
  const pass = listPasses().find((p) => p.id === id);
  if (!pass) return undefined;
  if (pass.status === "active") {
    pass.status = "revoked";
    savePass(pass);
    eventBus.publish({ type: "pass_revoked", at: new Date().toISOString(), pass });
  }
  return pass;
}

// --- Grace-period extension flow -------------------------------------------
//
// State machine on `Pass.extension` (see the doc comment on `PassExtension`
// in types.ts): undefined -> "pending" -> "approved" | "denied". Only a pass
// that's expired within GRACE_REQUEST_WINDOW_MS, and has never asked before,
// may request one; only a "pending" request can be approved or denied; only
// an "approved" one that's still within EXTENSION_USABLE_WINDOW_MS of the
// decision, and hasn't already been spent, actually unlocks a check-in (see
// `hasUsableApprovedExtension`, used by `checkIn` above).

function isWithinGraceWindow(pass: Pass, now: Date): boolean {
  return now.getTime() - new Date(pass.validUntil).getTime() <= GRACE_REQUEST_WINDOW_MS;
}

function hasUsableApprovedExtension(pass: Pass, now: Date): boolean {
  const ext = pass.extension;
  if (!ext || ext.status !== "approved" || ext.usedAt || !ext.decidedAt) return false;
  return now.getTime() - new Date(ext.decidedAt).getTime() <= EXTENSION_USABLE_WINDOW_MS;
}

export interface ExtensionRequestResult {
  ok: boolean;
  reason?: string;
  pass?: Pass;
}

/** Called from `POST /checkin/:token/request-extension` — a visitor asking for a few more minutes on a pass that just expired. */
export async function requestExtension(token: string, notifier: Notifier): Promise<ExtensionRequestResult> {
  const pass = getPassByToken(token);
  if (!pass) {
    return { ok: false, reason: "This access link isn't valid." };
  }

  const now = new Date();
  const status = effectiveStatus(pass, now);
  if (status !== "expired") {
    return {
      ok: false,
      reason: "An extension can only be requested for a pass that has just expired.",
      pass,
    };
  }
  if (!isWithinGraceWindow(pass, now)) {
    return {
      ok: false,
      reason: "Too much time has passed since this pass expired to request an extension — ask the household to issue a new pass.",
      pass,
    };
  }
  if (pass.extension) {
    return {
      ok: false,
      reason: `An extension has already been ${pass.extension.status === "pending" ? "requested" : pass.extension.status} for this pass.`,
      pass,
    };
  }

  const extension: PassExtension = { status: "pending", requestedAt: now.toISOString() };
  pass.extension = extension;
  savePass(pass);

  await notifier.send(
    "homeowner",
    "push",
    `${pass.visitorName}'s pass just expired and they're asking for a few more minutes to check in — approve or deny their request.`
  );

  return { ok: true, pass };
}

export interface ExtensionDecisionResult {
  ok: boolean;
  reason?: string;
  pass?: Pass;
}

/** Called from `POST /passes/:id/extension/approve` or `/deny` — the homeowner's decision on a pending request. */
export async function decideExtension(
  id: string,
  approve: boolean,
  notifier: Notifier,
  checkinBaseUrl?: string
): Promise<ExtensionDecisionResult> {
  const pass = getPassById(id);
  if (!pass) {
    return { ok: false, reason: "No pass with that ID." };
  }
  if (!pass.extension || pass.extension.status !== "pending") {
    return { ok: false, reason: "No pending extension request for this pass.", pass };
  }

  const now = new Date();
  pass.extension = { ...pass.extension, status: approve ? "approved" : "denied", decidedAt: now.toISOString() };
  savePass(pass);

  if (approve) {
    const link = checkinBaseUrl ? ` ${checkinBaseUrl}/checkin/${pass.checkinToken}` : "";
    await notifier.send(
      "visitor",
      "sms",
      `Good news — you've been granted a few more minutes. Tap to check in now:${link}`
    );
  } else {
    await notifier.send("visitor", "sms", `Sorry, your request for more time wasn't approved.`);
  }

  return { ok: true, pass };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatWindow(pass: Pass): string {
  if (pass.recurrence) {
    const days = pass.recurrence.daysOfWeek.map((d) => DAY_NAMES[d]).join("/");
    const until = new Date(pass.validUntil).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `every ${days} ${pass.recurrence.startTime}–${pass.recurrence.endTime} UTC, through ${until}`;
  }
  const until = new Date(pass.validUntil);
  return `until ${until.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`;
}

export { listPasses, listVisits };
