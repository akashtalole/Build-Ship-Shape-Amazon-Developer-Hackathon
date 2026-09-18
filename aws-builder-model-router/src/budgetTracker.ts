/**
 * Cost-budget enforcement for the router's paid model tiers (the mid-tier
 * reviewer and the full foundation model — the sidecar's own tiny cost is
 * always incurred and isn't budgeted). Chosen model: a **dollar-amount cap
 * per fixed window** (`limitUsd` per `periodMs`), not a rolling window and
 * not a request-count cap.
 *
 * Why a fixed window instead of rolling: a rolling window (e.g. "the sum of
 * spend in the trailing 60 minutes") is the more accurate model of "spend
 * per hour," but requires keeping a timestamped log of every charge and
 * summing/pruning it on every check — real bookkeeping overhead for a demo.
 * A fixed window is a running total that resets to zero the instant the
 * window elapses: a few lines of easily-audited logic, at the cost of the
 * same well-known fixed-window artifact `RateLimiter` already documents (see
 * rateLimiter.ts) — a burst of spend right at the boundary, followed by
 * another burst right after it resets, can spend close to 2x the nominal
 * per-period budget across that boundary. For a hackathon demo whose point is
 * "prove the router can be made to stop spending," that's an acceptable,
 * clearly-documented tradeoff rather than a silently-glossed-over one.
 *
 * Why dollars instead of a request-count cap: the router already tracks a
 * simulated cost per tier (`SIDECAR_COST_USD`, `REVIEWER_COST_USD`,
 * `FOUNDATION_COST_USD` in router.ts), so a dollar budget reuses that existing
 * cost model directly and answers the question a real operator actually has
 * ("don't let this feature's AWS bill exceed $X/hour") rather than a proxy
 * for it.
 */

export interface BudgetConfig {
  /** Dollar spend allowed per period before the router auto-throttles. */
  limitUsd: number;
  /** Fixed window length, in milliseconds. */
  periodMs: number;
}

export interface BudgetStatus {
  enabled: boolean;
  limitUsd: number | null;
  periodMs: number | null;
  spendUsd: number;
  remainingUsd: number | null;
  exceeded: boolean;
  periodStartedAt: number | null;
  periodEndsAt: number | null;
  msRemainingInPeriod: number | null;
}

/** Raw internal state, exposed for the persistent-metrics feature to save/restore verbatim. */
export interface BudgetTrackerState {
  limitUsd: number;
  periodMs: number;
  spendUsd: number;
  periodStartedAt: number;
}

export class BudgetTracker {
  private config: BudgetConfig | null = null;
  private spendUsd = 0;
  private periodStartedAt = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Enables budget enforcement (or replaces an existing budget), starting a fresh period with $0 spend. */
  configure(limitUsd: number, periodMs: number): void {
    this.config = { limitUsd, periodMs };
    this.spendUsd = 0;
    this.periodStartedAt = this.now();
  }

  /** Disables budget enforcement entirely — escalations are never throttled while unconfigured. */
  clear(): void {
    this.config = null;
    this.spendUsd = 0;
    this.periodStartedAt = 0;
  }

  private rolloverIfElapsed(): void {
    if (!this.config) return;
    const now = this.now();
    if (now - this.periodStartedAt >= this.config.periodMs) {
      this.periodStartedAt = now;
      this.spendUsd = 0;
    }
  }

  /** True once cumulative spend for the current period has reached (or passed) the configured limit. Always false when no budget is configured. */
  isExceeded(): boolean {
    if (!this.config) return false;
    this.rolloverIfElapsed();
    return this.spendUsd >= this.config.limitUsd;
  }

  /** Records an incurred cost against the current period. A no-op when no budget is configured. */
  record(costUsd: number): void {
    if (!this.config) return;
    this.rolloverIfElapsed();
    this.spendUsd += costUsd;
  }

  status(): BudgetStatus {
    if (!this.config) {
      return {
        enabled: false,
        limitUsd: null,
        periodMs: null,
        spendUsd: 0,
        remainingUsd: null,
        exceeded: false,
        periodStartedAt: null,
        periodEndsAt: null,
        msRemainingInPeriod: null,
      };
    }
    this.rolloverIfElapsed();
    const periodEndsAt = this.periodStartedAt + this.config.periodMs;
    return {
      enabled: true,
      limitUsd: this.config.limitUsd,
      periodMs: this.config.periodMs,
      spendUsd: this.spendUsd,
      remainingUsd: Math.max(0, this.config.limitUsd - this.spendUsd),
      exceeded: this.spendUsd >= this.config.limitUsd,
      periodStartedAt: this.periodStartedAt,
      periodEndsAt,
      msRemainingInPeriod: Math.max(0, periodEndsAt - this.now()),
    };
  }

  /** Exports raw state for persistence. Returns null when no budget is configured. */
  exportState(): BudgetTrackerState | null {
    if (!this.config) return null;
    return { limitUsd: this.config.limitUsd, periodMs: this.config.periodMs, spendUsd: this.spendUsd, periodStartedAt: this.periodStartedAt };
  }

  /** Restores raw state from persistence verbatim (no rollover check — the loaded period is trusted as-is; the next `isExceeded`/`record`/`status` call will roll it over if it has since elapsed). */
  hydrate(state: BudgetTrackerState | null): void {
    if (!state) {
      this.clear();
      return;
    }
    this.config = { limitUsd: state.limitUsd, periodMs: state.periodMs };
    this.spendUsd = state.spendUsd;
    this.periodStartedAt = state.periodStartedAt;
  }
}
