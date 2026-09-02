/**
 * A tiny fixed-window rate limiter for `POST /games/:id/ask`, protecting the
 * (potentially LLM-backed, i.e. per-call-cost) Q&A path from a spammy or
 * runaway client — a remote button mashed repeatedly, or a buggy voice
 * front end that fires a request per partial transcript. Keyed by whatever
 * the caller passes in (viewer ID when known, IP address otherwise), scoped
 * per game so one viewer hammering one game doesn't affect their questions
 * on another.
 *
 * In-memory and per-process, matching every other piece of state in this
 * service (see `store.ts`) — fine for a single-instance demo; a
 * multi-instance deployment would move this to a shared store (e.g. Redis
 * `INCR` + `EXPIRE`) behind the same two functions.
 */

export const ASK_RATE_LIMIT_MAX = 10;
export const ASK_RATE_LIMIT_WINDOW_MS = 60_000;

const hitsByKey = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  /** Present only when `allowed` is false: how long until the oldest hit in the window ages out. */
  retryAfterMs?: number;
}

/**
 * Records a hit for `key` and reports whether it's within the allowed rate.
 * Exposed with overridable `max`/`windowMs` for tests; production call sites
 * use the defaults.
 */
export function checkRateLimit(
  key: string,
  max: number = ASK_RATE_LIMIT_MAX,
  windowMs: number = ASK_RATE_LIMIT_WINDOW_MS,
  now: number = Date.now()
): RateLimitResult {
  const recent = (hitsByKey.get(key) ?? []).filter((t) => now - t < windowMs);

  if (recent.length >= max) {
    hitsByKey.set(key, recent);
    return { allowed: false, retryAfterMs: windowMs - (now - recent[0]) };
  }

  recent.push(now);
  hitsByKey.set(key, recent);
  return { allowed: true };
}
