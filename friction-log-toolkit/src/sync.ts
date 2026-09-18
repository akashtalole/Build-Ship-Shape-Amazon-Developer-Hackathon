import { readLog, writeLog } from "./store.js";
import { mergeEntries } from "./commands.js";
import type { LogEntry } from "./types.js";

/**
 * `friction-log sync <url> [--push|--pull]` — a minimal HTTP contract for
 * exchanging entries with a remote, reusing the exact same id-based
 * dedup logic `merge` uses (`mergeEntries`, from `commands.ts`) so running
 * a sync repeatedly against the same remote is always safe.
 *
 * The contract (either side can be implemented by anything that speaks
 * plain JSON over HTTP — no server code is shipped here, only the client):
 *
 *   GET  <url>   -> 200, JSON body `{ "entries": LogEntry[] }`
 *                   The remote's current full entry list.
 *
 *   POST <url>   -> request body `{ "entries": LogEntry[] }` (the pusher's
 *                   full local entry list), response 200 with JSON body
 *                   `{ "added": number, "duplicates": number, "total": number }`
 *                   describing what happened to the *remote's* store after
 *                   merging in the pushed entries (via the same
 *                   `mergeEntries` id-based dedup) — `total` is the
 *                   remote's entry count after the merge.
 *
 * `--pull` does a GET, merges the remote's entries into the local log
 * (local entries win ties by id — merging is idempotent either way since
 * ids are stable), and reports the *local* added/duplicates/total.
 *
 * `--push` does a POST of the full local log and reports back whatever
 * added/duplicates/total the remote's response says happened there. This
 * client never assumes anything about how the remote persists its side —
 * only that it speaks this JSON contract.
 */

export interface SyncResult {
  added: number;
  duplicates: number;
  total: number;
}

async function parseJsonResponse(res: Response, context: string): Promise<any> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${context} did not return valid JSON.`);
  }
  return body;
}

/**
 * Fetches just the remote's raw entry list via the `GET` half of the sync
 * contract — pulled out of `pullSync` so `aggregate` (which pulls from
 * *multiple* teammates' remotes without writing any of them into a local
 * log) can reuse the exact same request/validation logic instead of
 * duplicating it.
 */
export async function fetchRemoteEntries(url: string): Promise<LogEntry[]> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  const body = await parseJsonResponse(res, `GET ${url}`);
  if (!body || !Array.isArray(body.entries)) {
    throw new Error(`GET ${url} did not return a { entries: [...] } payload.`);
  }
  return body.entries as LogEntry[];
}

/** Pulls the remote's entries at `url` and merges them into the local log at `dir`. */
export async function pullSync(dir: string, url: string): Promise<SyncResult> {
  const remoteEntries = await fetchRemoteEntries(url);
  const log = readLog(dir);
  const { entries, added, duplicates } = mergeEntries(log.entries, remoteEntries);
  writeLog(dir, { ...log, entries });
  return { added, duplicates, total: entries.length };
}

/** Pushes the local log at `dir` to the remote at `url`. */
export async function pushSync(dir: string, url: string): Promise<SyncResult> {
  const log = readLog(dir);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: log.entries }),
    });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText}`);
  }
  const body = await parseJsonResponse(res, `POST ${url}`);
  if (
    !body ||
    typeof body.added !== "number" ||
    typeof body.duplicates !== "number" ||
    typeof body.total !== "number"
  ) {
    throw new Error(`POST ${url} did not return a { added, duplicates, total } payload.`);
  }
  return { added: body.added, duplicates: body.duplicates, total: body.total };
}
