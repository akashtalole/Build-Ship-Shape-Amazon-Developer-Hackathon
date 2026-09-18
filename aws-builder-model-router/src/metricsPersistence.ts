import { readFileSync, writeFileSync } from "node:fs";
import type { CircuitState } from "./types.js";
import type { BudgetTrackerState } from "./budgetTracker.js";

/**
 * Demo-grade file-based persistence for the router's cumulative metrics —
 * explicitly NOT a real database. It exists purely so restarting the demo
 * process (or a crash) doesn't silently reset the cost-savings story back to
 * zero mid-demo. Honest limitations, same framing as this repo's other
 * simple file-based persistence:
 *
 *   - Plain synchronous `fs.writeFileSync` — no atomic rename-on-write, so a
 *     process killed mid-write could in principle leave a truncated file.
 *   - No file locking — two processes pointed at the same path would clobber
 *     each other. Fine for the single-process server this demo runs.
 *   - No schema migration beyond a bare `version` tag: an incompatible or
 *     corrupt file is treated as "nothing to load," not repaired.
 *
 * All of that is the right set of simplifications for a single-process
 * hackathon demo and the wrong set for production, which would reach for a
 * real datastore (DynamoDB, RDS, even a managed key-value cache) instead.
 */

export interface PersistedMetricsState {
  version: 1;
  savedAt: string;

  sidecarPathRequests: number;
  reviewerPathRequests: number;
  foundationPathRequests: number;
  fallbackRequests: number;
  budgetThrottledRequests: number;

  cacheHits: number;
  cacheMisses: number;

  cumulativeActualCostUsd: number;

  circuitState: CircuitState;
  consecutiveFoundationFailures: number;
  circuitOpenedAt: number;

  shadowEvaluations: number;
  shadowAgreements: number;

  lastThresholdUsed: number;

  budget: BudgetTrackerState | null;
}

/** Reads and parses a metrics file. Returns null (rather than throwing) for a missing file, unreadable file, or corrupt/incompatible JSON — the router starts fresh in every one of those cases instead of crashing the demo. */
export function loadMetricsState(path: string): PersistedMetricsState | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedMetricsState>;
    if (!parsed || parsed.version !== 1) return null;
    return parsed as PersistedMetricsState;
  } catch {
    return null;
  }
}

/** Writes the given state to `path`, stamping a fresh `savedAt` timestamp. */
export function saveMetricsState(path: string, state: Omit<PersistedMetricsState, "version" | "savedAt">): void {
  const full: PersistedMetricsState = { version: 1, savedAt: new Date().toISOString(), ...state };
  writeFileSync(path, JSON.stringify(full, null, 2), "utf8");
}
