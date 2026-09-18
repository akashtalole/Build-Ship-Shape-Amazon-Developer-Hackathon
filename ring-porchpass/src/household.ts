/**
 * Household membership + roles. Deliberately the simplest thing that
 * demonstrates real authorization scoping without inventing an auth system
 * this hackathon demo doesn't need: there is no login, password, or session
 * — a caller identifies themselves with a plain `X-PorchPass-Member` header
 * (or a `?member=` query param, so a plain browser/curl GET can supply one
 * too) naming a registered member id. `resolveCaller`/`requireRole` trust
 * that header at face value. A real deployment would replace this with
 * actual authenticated sessions (each household member signs in; the server
 * reads their identity off a verified session or JWT, not a caller-supplied
 * header) — see FRICTION_LOG.md for the honest version of this tradeoff,
 * same framing as the rate limiter's and encryption key's own caveats.
 *
 * The very first member, `"owner"`, is pre-seeded with the `owner` role, and
 * a caller that supplies NO member header at all resolves to that default
 * owner rather than being rejected. That's what keeps every endpoint and
 * every existing test from every earlier round working completely
 * unchanged: nothing before this round ever knew "callers" were a concept,
 * so nothing before this round can be broken by adding one.
 */

export type HouseholdRole = "owner" | "member";

export interface HouseholdMember {
  id: string;
  name?: string;
  role: HouseholdRole;
  addedAt: string; // ISO timestamp
}

const DEFAULT_OWNER_ID = "owner";

const members = new Map<string, HouseholdMember>();

function seedDefaultOwner(): void {
  members.set(DEFAULT_OWNER_ID, {
    id: DEFAULT_OWNER_ID,
    name: "Household Owner",
    role: "owner",
    addedAt: new Date().toISOString(),
  });
}
seedDefaultOwner();

export function listMembers(): HouseholdMember[] {
  return [...members.values()].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

export function getMember(id: string): HouseholdMember | undefined {
  return members.get(id);
}

export function addOrUpdateMember(id: string, options: { name?: string; role: HouseholdRole }): HouseholdMember {
  const existing = members.get(id);
  const member: HouseholdMember = {
    id,
    name: options.name ?? existing?.name,
    role: options.role,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  };
  members.set(id, member);
  return member;
}

/** The seeded default owner can't be removed in this demo — there must always be at least one owner, and this is the simplest way to guarantee that without a "last owner" check elsewhere. */
export function removeMember(id: string): boolean {
  if (id === DEFAULT_OWNER_ID) return false;
  return members.delete(id);
}

export interface CallerError {
  status: number;
  message: string;
}

export interface CallerResolution {
  member?: HouseholdMember;
  error?: CallerError;
}

/**
 * No caller id at all -> the default owner (see the module doc comment on
 * why). A caller id that doesn't match any registered member is a hard
 * error, not a silent fallback to the lowest privilege — silently degrading
 * an unrecognized id to "member" would make it impossible to ever prove a
 * given caller isn't allowed to do something, since every rejection could
 * just be "well, register that id and see."
 */
export function resolveCaller(callerId: string | undefined | null): CallerResolution {
  if (!callerId) return { member: members.get(DEFAULT_OWNER_ID) };
  const member = members.get(callerId);
  if (!member) {
    return {
      error: { status: 401, message: `Unknown household member id '${callerId}'. See GET /household/members.` },
    };
  }
  return { member };
}

export function requireRole(callerId: string | undefined | null, role: HouseholdRole): CallerResolution {
  const resolved = resolveCaller(callerId);
  if (resolved.error) return resolved;
  if (resolved.member!.role !== role) {
    return {
      error: {
        status: 403,
        message: `This action requires the '${role}' role; '${resolved.member!.id}' has role '${resolved.member!.role}'.`,
      },
    };
  }
  return resolved;
}
