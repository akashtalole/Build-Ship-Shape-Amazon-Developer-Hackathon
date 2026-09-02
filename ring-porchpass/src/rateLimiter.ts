/**
 * Fixed-window-ish rate limiter for check-in attempts, keyed by the
 * `checkinToken` being attempted (valid or not — an attacker guessing at
 * tokens is exactly what this protects against, so unknown tokens must count
 * too). In-memory `Map`, which is the right tradeoff for a single-instance
 * hackathon demo; see FRICTION_LOG.md for the multi-instance caveat (a real
 * deployment behind more than one process/replica needs a shared store, e.g.
 * Redis, or the limit is trivially bypassed by hitting a different instance).
 */

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

const attemptsByKey = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export function checkAndRecordAttempt(key: string, now: number = Date.now()): RateLimitResult {
  const recent = (attemptsByKey.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_ATTEMPTS) {
    attemptsByKey.set(key, recent);
    const oldest = recent[0];
    return { allowed: false, retryAfterMs: Math.max(0, WINDOW_MS - (now - oldest)) };
  }

  recent.push(now);
  attemptsByKey.set(key, recent);
  return { allowed: true };
}

export const RATE_LIMIT_WINDOW_MS = WINDOW_MS;
export const RATE_LIMIT_MAX_ATTEMPTS = MAX_ATTEMPTS;
