import { randomUUID } from "node:crypto";
import type { Pass, PassExtension, RecurrenceRule, Visit } from "./types.js";
import {
  addVisit,
  findOpenVisitForPass,
  getPassById,
  getPassByToken,
  getPassIdByIdempotencyKey,
  listPasses,
  listVisits,
  rememberIdempotencyKey,
  savePass,
  updateVisit,
} from "./store.js";
import type { RingClient } from "./ringClient.js";
import type { Notifier } from "./notify.js";
import { isWithinRecurrence } from "./recurrence.js";
import { getSettings, isWithinQuietHours } from "./settings.js";
import { checkAndRecordAttempt } from "./rateLimiter.js";
import { eventBus } from "./eventBus.js";
import { FRONT_DOOR_DEVICE_ID, registerDevice } from "./devices.js";
import { decryptField, encryptField, maskPhone, phoneLookupKey } from "./crypto.js";
import { formatDuration } from "./format.js";
import { computeTrustScore } from "./trust.js";
import { DEFAULT_GEOFENCE_RADIUS_METERS, type GeoVerifier } from "./geo.js";
import { broadcastNeighborhoodAlert, recordFailedCheckIn, recordRevokedCheckInAttempt } from "./neighborhoodWatch.js";

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
  autoApproveExtensionsAboveTrust?: number; // round 5: auto-approve a grace-period extension request once this visitor's trust score is >= this value
  requireGeofence?: boolean; // round 5: this pass can't check in until a location ping confirms the visitor is near the property
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
    // Encrypted immediately — the plaintext `input.visitorPhone` never gets
    // assigned onto the `Pass` object that `savePass` puts in the store; see
    // crypto.ts and `decryptVisitorPhone` below for the only place it comes
    // back out.
    visitorPhoneEnc: encryptField(input.visitorPhone),
    // A one-way HMAC of the same plaintext number — see the doc comment on
    // `Pass.visitorPhoneLookup` and `crypto.ts#phoneLookupKey`. Computed once,
    // here, from the only place `issuePass` ever sees the plaintext.
    visitorPhoneLookup: phoneLookupKey(input.visitorPhone),
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
    autoApproveExtensionsAboveTrust: input.autoApproveExtensionsAboveTrust,
    requireGeofence: input.requireGeofence,
  };
  savePass(pass);
  if (input.idempotencyKey) {
    rememberIdempotencyKey(input.idempotencyKey, pass.id);
  }

  const link = `${input.baseUrl}/checkin/${pass.checkinToken}`;
  await notifier.send(
    "visitor",
    "sms",
    `Hi ${pass.visitorName}, you have access to the house ${formatWindow(pass)}. Tap to let us know you've arrived: ${link}`,
    decryptVisitorPhone(pass) // decrypted right here, at the one moment an actual send needs it
  );

  eventBus.publish({ type: "pass_issued", at: now.toISOString(), pass });

  return pass;
}

/** The only sanctioned way to get a pass's visitor phone number back in plaintext — see the doc comment on `Pass.visitorPhoneEnc`. */
export function decryptVisitorPhone(pass: Pass): string {
  return decryptField(pass.visitorPhoneEnc);
}

/**
 * The shape `POST /passes`, `GET /passes`, and every other route that hands
 * a `Pass` back to an API caller actually returns: the encrypted field is
 * dropped and replaced with a masked `visitorPhone` a homeowner can still
 * use to recognize which visitor a pass belongs to (e.g. "•••••••1234"),
 * without the API ever re-exposing the full plaintext number it took care to
 * encrypt at rest in the first place.
 */
export type PassView = Omit<Pass, "visitorPhoneEnc" | "visitorPhoneLookup"> & { visitorPhone: string };

export function serializePass(pass: Pass): PassView {
  const { visitorPhoneEnc: _visitorPhoneEnc, visitorPhoneLookup: _visitorPhoneLookup, ...rest } = pass;
  return { ...rest, visitorPhone: maskPhone(decryptVisitorPhone(pass)) };
}

/** Recomputes status against the current time without mutating a pass that's still genuinely active. */
export function effectiveStatus(pass: Pass, now = new Date()): Pass["status"] {
  if (pass.status === "revoked" || pass.status === "used_up") return pass.status;
  if (now.getTime() > new Date(pass.validUntil).getTime()) return "expired";
  return pass.status;
}

export type CheckInReasonCode =
  | "expired"
  | "revoked"
  | "used_up"
  | "not_yet_valid"
  | "recurrence"
  | "geofence"
  | "quiet_hours";

export interface CheckInResult {
  ok: boolean;
  reason?: string;
  reasonCode?: CheckInReasonCode; // machine-readable companion to `reason` — used by neighborhoodWatch.ts's risk detection so it isn't parsing prose
  pass?: Pass;
  visit?: Visit;
  rateLimited?: boolean;
  // Set on a rejection whose only problem is that the pass *just* expired —
  // the visitor may call `POST /checkin/:token/request-extension` instead of
  // being turned away outright. Never true alongside `ok: true`.
  graceEligible?: boolean;
}

interface CheckInConfirmation {
  confirmedVia: "link" | "voice";
  confirmedByMember?: string; // household member id, when confirmedVia === "voice"
}

/**
 * The actual access-control decision, shared by every way a check-in can be
 * confirmed: the visitor tapping their link (`checkIn`, below) and a
 * household member voice-confirming them instead (`voiceConfirmCheckIn`,
 * round 5's Alexa+ integration seam). Identical policy either way — *how*
 * a visitor's identity got confirmed doesn't change whether the pass itself
 * is valid, recurring-window-scoped, geofenced, or subject to quiet hours.
 */
async function performCheckIn(
  pass: Pass,
  ringClient: RingClient,
  notifier: Notifier,
  confirmation: CheckInConfirmation
): Promise<CheckInResult> {
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
      return { ok: false, reason: "This pass has expired.", reasonCode: "expired", pass, graceEligible };
    }
  }
  if (status === "revoked") {
    return { ok: false, reason: "This pass has been revoked.", reasonCode: "revoked", pass };
  }
  if (status === "used_up") {
    return { ok: false, reason: "This pass has already been used.", reasonCode: "used_up", pass };
  }
  if (!usingExtension && now.getTime() < new Date(pass.validFrom).getTime()) {
    return { ok: false, reason: "This pass isn't active yet.", reasonCode: "not_yet_valid", pass };
  }

  // Recurring passes narrow validity further within [validFrom, validUntil]:
  // even though the overall schedule is still active, "now" must also fall
  // inside one of the configured day/time windows. Moot once an extension is
  // in play — the whole outer schedule has already ended by definition.
  if (!usingExtension && pass.recurrence && !isWithinRecurrence(pass.recurrence, now)) {
    return {
      ok: false,
      reason: "This pass's recurring schedule doesn't cover the current day/time.",
      reasonCode: "recurrence",
      pass,
    };
  }

  // Geofenced activation (round 5): unlike recurrence, this is NOT skipped
  // for a grace-period extension — an extension only forgives the pass being
  // outside its own *time* window, it says nothing about the visitor's
  // *location*, so a pass requiring proximity confirmation still requires it
  // here. See geo.ts and `POST /passes/:id/location-ping`.
  if (pass.requireGeofence && !pass.geofenceConfirmedAt) {
    return {
      ok: false,
      reason: "This pass requires confirming you're near the property before checking in — send a location ping first.",
      reasonCode: "geofence",
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
      reasonCode: "quiet_hours",
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
    confirmedVia: confirmation.confirmedVia,
    confirmedByMember: confirmation.confirmedByMember,
    usedGraceExtension: usingExtension || undefined,
  };
  addVisit(visit);

  const clipNote = matchedEvent ? ` See the doorbell snapshot: ${matchedEvent.snapshotUrl}` : "";
  const viaNote = confirmation.confirmedVia === "voice" ? ` (voice-confirmed by ${confirmation.confirmedByMember})` : "";
  await notifier.send(
    "homeowner",
    "push",
    `${pass.visitorName} (${pass.note ?? "guest"}) just checked in${viaNote}.${clipNote}`
  );

  eventBus.publish({ type: "visit_checkin", at: now.toISOString(), pass, visit });

  return { ok: true, pass, visit };
}

/**
 * Round 5 (neighborhood alert broadcast): after any check-in attempt that
 * did NOT succeed, feed it into `neighborhoodWatch.ts`'s risk detectors and
 * broadcast an alert the moment a real pattern is found. Runs for every
 * failure path (`checkIn` and `voiceConfirmCheckIn` alike) — the risk a
 * pattern like this signals has nothing to do with which door the attempt
 * came through.
 */
function trackCheckInRisk(pass: Pass, result: CheckInResult): void {
  if (result.ok) return;
  if (result.reasonCode === "revoked") {
    const revocationSignal = recordRevokedCheckInAttempt(pass.id);
    if (revocationSignal) broadcastNeighborhoodAlert(revocationSignal, pass.visitorName);
  }
  const failureSignal = recordFailedCheckIn(pass.id);
  if (failureSignal) broadcastNeighborhoodAlert(failureSignal, pass.visitorName);
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

  const result = await performCheckIn(pass, ringClient, notifier, { confirmedVia: "link" });
  trackCheckInRisk(pass, result);
  return result;
}

/**
 * Round 5's Alexa+ ecosystem tie-in: a household member confirming a
 * visitor's identity out loud (e.g. "yes, let the dog walker in" in response
 * to a doorbell announcement) instead of the visitor tapping their link. This
 * is the seam a real Alexa+ skill/MCP client would call — see
 * `POST /passes/:id/voice-confirm` in server.ts and the README section on
 * it for the full framing (mirroring how `ringClient.ts` documents the Ring
 * integration seam).
 *
 * Identified by pass ID rather than a check-in token: a voice command names
 * a visitor/pass, not a token from the visitor's own SMS. `memberId` is
 * whichever household member is speaking (see `household.ts`'s caller
 * model) — the caller must already resolve to a known member; that check
 * happens in server.ts before this is ever called.
 */
export async function voiceConfirmCheckIn(
  passId: string,
  memberId: string,
  ringClient: RingClient,
  notifier: Notifier
): Promise<CheckInResult> {
  const rateLimit = checkAndRecordAttempt(`voice:${passId}`);
  if (!rateLimit.allowed) {
    const retryMinutes = Math.ceil((rateLimit.retryAfterMs ?? 0) / 60000);
    return {
      ok: false,
      rateLimited: true,
      reason: `Too many voice-confirm attempts for this pass. Please try again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`,
    };
  }

  const pass = getPassById(passId);
  if (!pass) {
    return { ok: false, reason: "No pass with that ID." };
  }

  const result = await performCheckIn(pass, ringClient, notifier, { confirmedVia: "voice", confirmedByMember: memberId });
  trackCheckInRisk(pass, result);
  return result;
}

// --- Geofenced pass activation (round 5) ------------------------------------
//
// A pass issued with `requireGeofence: true` can't check in — by link OR by
// voice confirmation, see `performCheckIn` above — until a location ping
// lands within the household's configured home radius. The "real" location
// source is deliberately behind the `GeoVerifier` seam (geo.ts), the same
// pattern `RingClient` uses for Ring itself: no real geolocation hardware is
// available in this sandboxed environment, so a raw lat/lng from a request
// body stands in for what a companion mobile app's native geolocation API
// would provide in production.

export interface LocationPingResult {
  ok: boolean;
  reason?: string;
  rateLimited?: boolean;
  distanceMeters?: number;
  withinRadius?: boolean;
  pass?: Pass;
}

export function submitLocationPing(passId: string, lat: number, lng: number, geoVerifier: GeoVerifier): LocationPingResult {
  // Same brute-force reasoning as check-in/checkout rate limiting: an
  // attacker probing for the configured radius by trial and error is exactly
  // what this budget protects against.
  const rateLimit = checkAndRecordAttempt(`geofence:${passId}`);
  if (!rateLimit.allowed) {
    const retryMinutes = Math.ceil((rateLimit.retryAfterMs ?? 0) / 60000);
    return {
      ok: false,
      rateLimited: true,
      reason: `Too many location pings for this pass. Please try again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`,
    };
  }

  const pass = getPassById(passId);
  if (!pass) {
    return { ok: false, reason: "No pass with that ID." };
  }
  if (!pass.requireGeofence) {
    return { ok: false, reason: "This pass doesn't require location confirmation.", pass };
  }

  const settings = getSettings();
  if (!settings.homeLocation) {
    return { ok: false, reason: "The household hasn't configured a home location yet — contact them directly.", pass };
  }

  const radiusMeters = settings.geofenceRadiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS;
  const { withinRadius, distanceMeters } = geoVerifier.verifyProximity(lat, lng, settings.homeLocation, radiusMeters);

  if (withinRadius) {
    pass.geofenceConfirmedAt = new Date().toISOString();
    savePass(pass);
    return { ok: true, withinRadius, distanceMeters, pass };
  }

  return {
    ok: false,
    withinRadius,
    distanceMeters,
    pass,
    reason: `You appear to be about ${Math.round(distanceMeters)}m from the property — check-in unlocks once you're within ${radiusMeters}m.`,
  };
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
  // Round 5: set when this request was decided instantly against
  // `pass.autoApproveExtensionsAboveTrust` instead of waiting on the
  // homeowner — see the trust-score check below.
  autoApproved?: boolean;
}

/**
 * Called from `POST /checkin/:token/request-extension` — a visitor asking
 * for a few more minutes on a pass that just expired. `checkinBaseUrl`
 * (round 5) is only used if the request is auto-approved on the spot — see
 * below — so the visitor's SMS can include a working check-in link exactly
 * like a homeowner's manual approval already does via `decideExtension`.
 */
export async function requestExtension(token: string, notifier: Notifier, checkinBaseUrl?: string): Promise<ExtensionRequestResult> {
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

  // Round 5 (visitor trust scoring): a homeowner can pre-authorize a
  // recurring visitor's future grace-period requests via
  // `autoApproveExtensionsAboveTrust`, so they're not asked to approve every
  // single one by hand. If set, and this visitor's current trust score (real
  // history: completed visits, revocations, no-shows, late arrivals — see
  // trust.ts) already clears that bar, decide it immediately via the exact
  // same `decideExtension` path a manual approval takes — no second,
  // duplicate approval code path to keep in sync.
  if (pass.autoApproveExtensionsAboveTrust !== undefined) {
    const trust = computeTrustScore(decryptVisitorPhone(pass), now);
    if (trust.score >= pass.autoApproveExtensionsAboveTrust) {
      const decision = await decideExtension(pass.id, true, notifier, checkinBaseUrl);
      return { ok: true, pass: decision.pass, autoApproved: true };
    }
  }

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
      `Good news — you've been granted a few more minutes. Tap to check in now:${link}`,
      decryptVisitorPhone(pass)
    );
  } else {
    await notifier.send("visitor", "sms", `Sorry, your request for more time wasn't approved.`, decryptVisitorPhone(pass));
  }

  return { ok: true, pass };
}

// --- Visit duration tracking ------------------------------------------------
//
// A "visit" used to be a single instant (`checkedInAt`). This pairs it with
// an optional departure: `POST /checkin/:token/checkout` is the visitor's
// "I'm leaving" tap, closing out the most recently opened visit for their
// pass that hasn't already been checked out of. A visit with no departure
// yet reads as "still on-site" (see `listVisitsWithStatus`); one with a
// departure carries a `durationMs` computed once, at checkout time.
//
// Deliberately a *separate* token action from arrival rather than a
// `direction` field on the existing check-in endpoint: checking in already
// carries meaning specific to arrival (correlating a Ring event, consuming a
// pass's use-count, enforcing quiet hours/recurrence/expiry) that a
// departure shouldn't re-run at all — a visitor leaving doesn't need to pass
// the same gauntlet of validity checks that let them in, they just need to
// mark that they left. See FRICTION_LOG.md for the edge cases this raised
// (a departure with no matching arrival, checking out twice, ...).

export interface CheckOutResult {
  ok: boolean;
  reason?: string;
  visit?: Visit;
  rateLimited?: boolean;
}

export async function checkOut(token: string, notifier: Notifier): Promise<CheckOutResult> {
  // Same brute-force protection as arrival check-ins, kept on an independent
  // budget (`checkout:${token}`) so a legitimate visitor's arrival attempts
  // never eat into their own ability to check out, or vice versa.
  const rateLimit = checkAndRecordAttempt(`checkout:${token}`);
  if (!rateLimit.allowed) {
    const retryMinutes = Math.ceil((rateLimit.retryAfterMs ?? 0) / 60000);
    return {
      ok: false,
      rateLimited: true,
      reason: `Too many checkout attempts for this link. Please try again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`,
    };
  }

  const pass = getPassByToken(token);
  if (!pass) {
    return { ok: false, reason: "This access link isn't valid." };
  }

  const openVisit = findOpenVisitForPass(pass.id);
  if (!openVisit) {
    // Covers both edge cases the same way, since neither has anything left
    // to close out: a departure with no matching arrival at all, and a
    // departure replayed after the matching visit was already checked out.
    return {
      ok: false,
      reason: "There's no active visit to check out of for this pass — either you haven't checked in yet, or you already checked out.",
    };
  }

  const now = new Date();
  const durationMs = now.getTime() - new Date(openVisit.checkedInAt).getTime();
  const closedVisit: Visit = { ...openVisit, checkedOutAt: now.toISOString(), durationMs };
  updateVisit(closedVisit);

  await notifier.send("homeowner", "push", `${pass.visitorName} just left (visit lasted ${formatDuration(durationMs)}).`);
  eventBus.publish({ type: "visit_checkout", at: now.toISOString(), pass, visit: closedVisit });

  return { ok: true, visit: closedVisit };
}

export type VisitStatus = "on_site" | "completed";
export type VisitView = Visit & { status: VisitStatus; onSiteForMs?: number };

/** `GET /visits`'s actual response shape: every stored visit, plus a derived `status` ("on_site" until a departure closes it, "completed" after) and, for one still on-site, how long it's been going so far. */
export function listVisitsWithStatus(now: Date = new Date()): VisitView[] {
  return listVisits().map((visit) => {
    if (visit.checkedOutAt) return { ...visit, status: "completed" as const };
    return { ...visit, status: "on_site" as const, onSiteForMs: now.getTime() - new Date(visit.checkedInAt).getTime() };
  });
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
