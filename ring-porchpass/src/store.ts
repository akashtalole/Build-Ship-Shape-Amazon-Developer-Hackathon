import type { Pass, Visit } from "./types.js";

const passes = new Map<string, Pass>();
const passesByToken = new Map<string, string>(); // checkinToken -> pass id
const visits: Visit[] = [];

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
