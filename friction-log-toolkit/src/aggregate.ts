import { fetchRemoteEntries } from "./sync.js";
import { mergeEntries } from "./commands.js";
import { clusterByTheme, type ThemeCluster } from "./cluster.js";
import type { LogEntry } from "./types.js";

/**
 * `friction-log aggregate <url1> <url2> ...` — team-wide triage built
 * directly on top of `sync`'s existing push/pull mechanism.
 *
 * Pulls entries from every teammate's running instance over the exact same
 * `GET` half of the sync HTTP contract `sync --pull` already speaks (via
 * the shared `fetchRemoteEntries`) — so anything already answering `sync`
 * is a valid `aggregate` source with zero new server-side code — merges
 * them (id-based dedup, the same `mergeEntries` `merge`/`sync` use), and
 * clusters the combined set by shared theme (`clusterByTheme`) instead of
 * just concatenating everyone's raw list. Five teammates who each
 * independently hit the same "MCP schema validation" style error end up as
 * one grouped theme with five entries under it, not five unrelated bullets
 * scattered across the report.
 */

export interface SourceError {
  url: string;
  error: string;
}

export interface AggregateReport {
  sources: string[];
  /** Sources that couldn't be reached — an offline teammate, a typo'd URL — recorded here instead of failing the whole aggregation. */
  sourceErrors: SourceError[];
  /** Entry count after id-based de-duplication across every reachable source. */
  totalEntries: number;
  duplicatesAcrossSources: number;
  clusters: ThemeCluster[];
}

export async function aggregate(urls: string[]): Promise<AggregateReport> {
  const sourceErrors: SourceError[] = [];
  let combined: LogEntry[] = [];
  let duplicatesAcrossSources = 0;

  for (const url of urls) {
    try {
      const remoteEntries = await fetchRemoteEntries(url);
      const { entries, added, duplicates } = mergeEntries(combined, remoteEntries);
      combined = entries;
      duplicatesAcrossSources += duplicates;
      void added; // reported implicitly via totalEntries/duplicatesAcrossSources below
    } catch (err) {
      sourceErrors.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const clusters = clusterByTheme(combined);

  return {
    sources: urls,
    sourceErrors,
    totalEntries: combined.length,
    duplicatesAcrossSources,
    clusters,
  };
}
