import { createHash } from "node:crypto";
import type { Request } from "express";
import { DEFAULT_HOUSEHOLD_ID } from "./store.js";

/**
 * Pulls a bearer token out of a request's `Authorization` header, if present.
 * Returns undefined for a missing header, a malformed header, or an empty
 * token — callers treat all of those the same way (fall back to the default
 * household).
 */
export function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token || undefined;
}

/**
 * Derives a stable household ID from a bearer token, so two clients using
 * the same token always land on the same household and two different tokens
 * never collide. No pre-registration required: an unrecognized token just
 * gets a fresh household the first time it's seen (see store.ts's
 * loadHousehold, which seeds an empty household for any ID it hasn't
 * persisted yet).
 *
 * The token itself is hashed rather than used verbatim so it never ends up
 * as a literal filename (or a literal chunk of a filename) on disk — the
 * household ID derived here becomes part of the JSON data file path.
 *
 * A missing token resolves to the single well-known default household, which
 * preserves the pre-multi-tenancy demo behavior (seeded sample data) for any
 * client that doesn't send an Authorization header at all.
 */
export function resolveHouseholdId(token: string | undefined): string {
  if (!token) return DEFAULT_HOUSEHOLD_ID;
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 20);
  return `hh-${digest}`;
}
