import type { Pass, Visit } from "./types.js";

const passes = new Map<string, Pass>();
const passesByToken = new Map<string, string>(); // checkinToken -> pass id
const visits: Visit[] = [];
// Idempotency-key cache: lets `POST /passes` be safely retried (e.g. a
// flaky mobile connection resubmitting the same request) without issuing a
// second pass or re-sending the visitor's "you have access" SMS.
const passIdByIdempotencyKey = new Map<string, string>();
// Round 5 (visitor trust scoring): every pass id ever issued to the same
// visitor identity, keyed by `visitorPhoneLookup` — a one-way HMAC of the
// phone number (see crypto.ts), never the plaintext. This is what lets
// `trust.ts` answer "what's this visitor's history?" across every pass
// they've ever been issued, without the store holding a reversible phone
// number anywhere.
const passIdsByPhoneLookup = new Map<string, Set<string>>();

export function savePass(pass: Pass): void {
  passes.set(pass.id, pass);
  passesByToken.set(pass.checkinToken, pass.id);
  if (pass.visitorPhoneLookup) {
    const existing = passIdsByPhoneLookup.get(pass.visitorPhoneLookup) ?? new Set<string>();
    existing.add(pass.id);
    passIdsByPhoneLookup.set(pass.visitorPhoneLookup, existing);
  }
}

/** Every pass id issued to the visitor identified by this lookup key — see the module doc comment above and `trust.ts`. */
export function getPassIdsByPhoneLookup(lookupKey: string): string[] {
  return [...(passIdsByPhoneLookup.get(lookupKey) ?? [])];
}

export function getPassById(id: string): Pass | undefined {
  return passes.get(id);
}

export function getPassByToken(token: string): Pass | undefined {
  const id = passesByToken.get(token);
  return id ? passes.get(id) : undefined;
}

export function listPasses(): Pass[] {
  return [...passes.values()].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

export function addVisit(visit: Visit): void {
  visits.push(visit);
}

export function listVisits(): Visit[] {
  return [...visits].sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
}

/** Replaces a visit already in the log by id — used by `passService.checkOut` to record a departure on the visit its matching arrival created. */
export function updateVisit(visit: Visit): void {
  const index = visits.findIndex((v) => v.id === visit.id);
  if (index !== -1) visits[index] = visit;
}

/**
 * The most recent visit for `passId` that has an arrival but no departure
 * yet — what a checkout closes out. Most-recent-first so that a multi-use
 * pass which arrived more than once without checking out in between closes
 * the most recently opened visit first (LIFO), the same order a person
 * would naturally describe "which visit am I ending" in.
 */
export function findOpenVisitForPass(passId: string): Visit | undefined {
  for (let i = visits.length - 1; i >= 0; i--) {
    if (visits[i].passId === passId && !visits[i].checkedOutAt) return visits[i];
  }
  return undefined;
}

export function getPassIdByIdempotencyKey(key: string): string | undefined {
  return passIdByIdempotencyKey.get(key);
}

export function rememberIdempotencyKey(key: string, passId: string): void {
  passIdByIdempotencyKey.set(key, passId);
}
