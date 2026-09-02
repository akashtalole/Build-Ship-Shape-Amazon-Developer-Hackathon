/**
 * Lightweight in-memory, fixed-window rate limiter keyed by an arbitrary
 * caller id (the Express layer keys it off the `X-Caller-Id` request
 * header). Any real deployment sharing an AWS resource across callers
 * (a SageMaker endpoint, a Bedrock model) needs some form of quota
 * management so one noisy caller can't starve the others or blow the
 * demo's simulated cost budget — this is the simplest version of that
 * pattern that's still genuinely enforcing a limit rather than a stub.
 *
 * Fixed-window (not sliding-window/token-bucket) is a deliberate choice for
 * this demo: it's a few lines of easily-audited logic, at the cost of
 * allowing up to 2x `limit` requests across a window boundary. A production
 * system fronting a real AWS bill would likely reach for a sliding window or
 * token bucket instead — noted here rather than silently glossed over.
 */

export interface RateLimiterOptions {
  /** Max requests allowed per caller within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window resets (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly options: RateLimiterOptions,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Records one request attempt for `callerId` and reports whether it's allowed. */
  check(callerId: string): RateLimitCheck {
    const now = this.now();
    let bucket = this.buckets.get(callerId);

    if (!bucket || now - bucket.windowStart >= this.options.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(callerId, bucket);
    }

    if (bucket.count >= this.options.limit) {
      return {
        allowed: false,
        limit: this.options.limit,
        remaining: 0,
        retryAfterMs: this.options.windowMs - (now - bucket.windowStart),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit: this.options.limit,
      remaining: this.options.limit - bucket.count,
      retryAfterMs: 0,
    };
  }

  /** Clears all tracked callers. Mainly useful for tests. */
  reset(): void {
    this.buckets.clear();
  }
}
