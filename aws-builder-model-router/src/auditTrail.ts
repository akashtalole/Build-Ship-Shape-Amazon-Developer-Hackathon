import { appendFileSync, readFileSync } from "node:fs";
import type { AuditRecord } from "./types.js";

/**
 * Per-request audit trail persistence (round 5) — deliberately reusing
 * `metricsPersistence.ts`'s established idioms rather than inventing a second
 * storage mechanism: plain synchronous Node `fs` calls, one file, no external
 * database, no locking, and the same "a read failure starts fresh/skips
 * rather than crashing the demo" honesty.
 *
 * One real difference from `metricsPersistence.ts`, worth naming explicitly:
 * that file persists a single fixed-size *snapshot* (cumulative counters) by
 * rewriting the whole file on every save, which is fine because the file's
 * size never grows. An audit trail is a *log* — one record per request,
 * unboundedly growing — so rewriting the entire file on every request would
 * be O(n) work (and O(n²) over a session) for no benefit. This file uses
 * **JSON Lines** (one compact JSON object per line, appended with
 * `appendFileSync`) instead: still a single plain-text file, still no
 * external service, still trivially inspectable with `cat`/`tail`/`jq`, but
 * appending a line is O(1) regardless of how large the file has already
 * grown. Same demo-grade caveats as `metricsPersistence.ts` apply: no atomic
 * rename-on-write (a process killed mid-append could in principle leave a
 * truncated final line, which `loadAuditRecords` simply skips rather than
 * failing the whole read), and no file locking (two processes appending to
 * the same path would interleave, fine for the single-process server this
 * demo runs).
 */

/** Appends one record to the durable audit log. Best-effort: a write failure (e.g. a bad path, a full disk) is swallowed rather than failing the request that triggered it — the record is still available in `ModelRouter`'s bounded in-memory buffer for that session, matching `metricsPersistence.ts`'s "never crash the demo over persistence" philosophy. */
export function appendAuditRecord(path: string, record: AuditRecord): void {
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort — see this file's doc comment.
  }
}

/**
 * Reads every record from the durable audit log, optionally filtered to
 * records at or after `sinceMs` (epoch milliseconds). Returns an empty array
 * (rather than throwing) for a missing file, unreadable file, or one that's
 * entirely corrupt — the export endpoint then honestly reports zero records
 * rather than failing outright, the same "missing/corrupt -> start fresh"
 * convention `metricsPersistence.ts`'s `loadMetricsState` uses. An individual
 * corrupt *line* (e.g. a truncated final line from a killed process) is
 * skipped rather than invalidating the whole file's worth of otherwise-good
 * records.
 */
export function loadAuditRecords(path: string, sinceMs?: number): AuditRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const records: AuditRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const record = JSON.parse(line) as AuditRecord;
      if (sinceMs === undefined || Date.parse(record.timestamp) >= sinceMs) {
        records.push(record);
      }
    } catch {
      // Skip a corrupt line rather than failing the whole export.
    }
  }
  return records;
}
