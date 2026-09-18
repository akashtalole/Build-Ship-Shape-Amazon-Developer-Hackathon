import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";
import { DEFAULT_HOUSEHOLD_ID } from "./store.js";
import type { AccessRole } from "./types.js";

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

// --------------------------------------------------------------------------
// Role-based access control
//
// Round 4's `resolveHouseholdId` is a pure hash: it never needs to remember
// anything about a token, which is exactly why an unrecognized token "just
// works" with no pre-registration. Roles break that purity — two tokens for
// the *same* household need to carry *different* roles (e.g. a full-access
// token for a parent and a read-only token for a kid's device), which a hash
// of the token alone can't express. So a small on-disk registry maps a
// token's hash to the {householdId, role} it was explicitly issued with
// (via the issue_household_token tool). A token that was never issued that
// way — including every token this server has ever supported before this
// round — isn't in the registry, and falls back to exactly round 4's
// behavior: a hash-derived household, `full-access` by default. This is
// what makes the round-4 "no token or unrecognized token" behavior stay
// unchanged: nothing about the fallback path changed, only a new registry
// lookup was added in front of it.
// --------------------------------------------------------------------------

interface TokenRecord {
  householdId: string;
  role: AccessRole;
  createdAt: string;
}

function tokensFilePath(): string {
  const dir = process.env.HOMEOPS_DATA_DIR
    ? path.resolve(process.env.HOMEOPS_DATA_DIR)
    : path.resolve(process.cwd(), "data");
  // Leading underscore so this can never collide with a household ID's file
  // — household IDs (DEFAULT_HOUSEHOLD_ID, or `hh-<hex>` from
  // resolveHouseholdId) never start with one.
  return path.join(dir, "_tokens.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function loadTokenRegistry(): Record<string, TokenRecord> {
  const file = tokensFilePath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, TokenRecord>;
  } catch {
    return {};
  }
}

function saveTokenRegistry(registry: Record<string, TokenRecord>): void {
  const file = tokensFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/**
 * Mints a brand-new bearer token bound to `householdId` with the given
 * role, and persists the mapping so any future session that connects with
 * this token resolves to that same household + role. The raw token is
 * returned exactly once — only its hash is ever stored, mirroring how
 * ring-porchpass's outbound-webhook secrets are generated and shown once.
 */
export function issueToken(householdId: string, role: AccessRole): string {
  const token = randomBytes(24).toString("hex");
  const registry = loadTokenRegistry();
  registry[hashToken(token)] = { householdId, role, createdAt: new Date().toISOString() };
  saveTokenRegistry(registry);
  return token;
}

export interface ResolvedAccess {
  householdId: string;
  role: AccessRole;
}

/**
 * The role-aware counterpart to resolveHouseholdId: looks up the token in
 * the registry first (an explicitly issue_household_token-minted token,
 * which may carry a role different from what a pure hash would derive), and
 * only falls back to hash-derivation + full-access for a token this server
 * has never issued — preserving round 4's exact behavior for every token
 * that predates roles.
 */
export function resolveAccess(token: string | undefined): ResolvedAccess {
  if (!token) return { householdId: DEFAULT_HOUSEHOLD_ID, role: "full-access" };

  const record = loadTokenRegistry()[hashToken(token)];
  if (record) return { householdId: record.householdId, role: record.role };

  return { householdId: resolveHouseholdId(token), role: "full-access" };
}
