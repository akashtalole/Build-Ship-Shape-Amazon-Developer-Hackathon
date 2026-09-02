import { randomUUID } from "node:crypto";
import type { Pass, RecurrenceRule, Visit } from "./types.js";
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

const FRONT_DOOR_DEVICE_ID = "front-door";
// How far back to look for a Ring event to correlate with a check-in — a
// visitor tapping the link and the doorbell/motion event should land within
// a few minutes of each other in any real-world flow.
const EVENT_CORRELATION_WINDOW_MS = 5 * 60 * 1000;

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
  if (status === "expired") {
    const wasAlreadyMarkedExpired = pass.status === "expired";
    pass.status = "expired";
    savePass(pass);
    if (!wasAlreadyMarkedExpired) {
      eventBus.publish({ type: "pass_expired", at: now.toISOString(), pass });
    }
    return { ok: false, reason: "This pass has expired.", pass };
  }
  if (status === "revoked") {
    return { ok: false, reason: "This pass has been revoked.", pass };
  }
  if (status === "used_up") {
    return { ok: false, reason: "This pass has already been used.", pass };
  }
  if (now.getTime() < new Date(pass.validFrom).getTime()) {
    return { ok: false, reason: "This pass isn't active yet.", pass };
  }

  // Recurring passes narrow validity further within [validFrom, validUntil]:
  // even though the overall schedule is still active, "now" must also fall
  // inside one of the configured day/time windows.
  if (pass.recurrence && !isWithinRecurrence(pass.recurrence, now)) {
    return {
      ok: false,
      reason: "This pass's recurring schedule doesn't cover the current day/time.",
      pass,
    };
  }

  // Household-level quiet hours override an otherwise-valid pass, unless the
  // pass explicitly opted out.
  const settings = getSettings();
  if (settings.quietHours && !pass.allowQuietHours && isWithinQuietHours(settings.quietHours, now)) {
    return {
      ok: false,
      reason: `Check-ins aren't accepted during quiet hours (${settings.quietHours.start}–${settings.quietHours.end} UTC).`,
      pass,
    };
  }

  const recentEvents = await ringClient.getRecentEvents(FRONT_DOOR_DEVICE_ID, EVENT_CORRELATION_WINDOW_MS);
  const matchedEvent = recentEvents[0]; // newest event in the correlation window, if any

  pass.useCount += 1;
  pass.status = pass.useCount >= pass.maxUses ? "used_up" : "active";
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
