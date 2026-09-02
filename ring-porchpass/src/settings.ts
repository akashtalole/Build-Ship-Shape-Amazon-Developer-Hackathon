/**
 * Household-level settings. There's exactly one household in this demo (a
 * single PorchPass deployment protects one home), so this is deliberately a
 * single mutable in-memory record rather than a per-household store — a
 * multi-tenant deployment would key this by household ID the same way it
 * would key `store.ts`.
 */

export interface QuietHours {
  start: string; // "HH:MM", UTC, 24h clock
  end: string; // "HH:MM", UTC, 24h clock — may be < start to cross midnight
}

export interface HouseholdSettings {
  quietHours?: QuietHours;
}

function quietHoursFromEnv(): QuietHours | undefined {
  const start = process.env.QUIET_HOURS_START;
  const end = process.env.QUIET_HOURS_END;
  if (start && end) return { start, end };
  return undefined;
}

let settings: HouseholdSettings = {
  quietHours: quietHoursFromEnv(),
};

export function getSettings(): HouseholdSettings {
  return settings;
}

export function updateSettings(partial: Partial<HouseholdSettings>): HouseholdSettings {
  settings = { ...settings, ...partial };
  return settings;
}

/**
 * Is `now` inside the quiet-hours window? Same UTC + midnight-crossing
 * handling as `recurrence.ts`'s `isWithinRecurrence` — kept as a separate,
 * smaller function here since quiet hours have no day-of-week component.
 */
export function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  const [sh, sm] = quietHours.start.split(":").map(Number);
  const [eh, em] = quietHours.end.split(":").map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (startMinutes === endMinutes) return false; // zero-length window
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Crosses midnight, e.g. 22:00 -> 07:00.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}
