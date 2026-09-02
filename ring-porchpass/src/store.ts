import type { Pass, Visit } from "./types.js";

const passes = new Map<string, Pass>();
const passesByToken = new Map<string, string>(); // checkinToken -> pass id
const visits: Visit[] = [];
// Idempotency-key cache: lets `POST /passes` be safely retried (e.g. a
// flaky mobile connection resubmitting the same request) without issuing a
// second pass or re-sending the visitor's "you have access" SMS.
const passIdByIdempotencyKey = new Map<string, string>();

export function savePass(pass: Pass): void {
  passes.set(pass.id, pass);
  passesByToken.set(pass.checkinToken, pass.id);
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

export function getPassIdByIdempotencyKey(key: string): string | undefined {
  return passIdByIdempotencyKey.get(key);
}

export function rememberIdempotencyKey(key: string, passId: string): void {
  passIdByIdempotencyKey.set(key, passId);
}
