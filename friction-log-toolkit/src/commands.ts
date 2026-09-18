import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LogAlreadyExistsError,
  generateEntryId,
  logExists,
  readLog,
  readLogFile,
  writeLog,
  writeLogFile,
} from "./store.js";
import {
  exportGithubIssues as buildGithubIssueFiles,
  exportJson,
  exportMarkdown,
  exportText,
  exportTimeline,
  type ExportFormat,
} from "./exporter.js";
import { readConfig } from "./config.js";
import { getGitInfo } from "./git.js";
import { suggestTag } from "./autotag.js";
import { fillTemplate, getTemplate } from "./templates.js";
import type { DailyCount } from "./chart.js";
import { scoreEntries, type SeverityBreakdown } from "./severity.js";
import { DEFAULT_TAG, type LogEntry, type LogFile, type Tag } from "./types.js";

/**
 * Command implementations, decoupled from argv parsing so they can be unit
 * tested directly (as the smoke test does) without shelling out.
 */

export class EntryNotFoundError extends Error {
  constructor(id: string) {
    super(`No entry with id "${id}" found. Run "friction-log list" to see valid ids.`);
    this.name = "EntryNotFoundError";
  }
}

export interface InitOptions {
  force?: boolean;
}

export interface InitResult {
  created: boolean;
  path: string;
}

export function init(dir: string, options: InitOptions = {}): InitResult {
  if (logExists(dir) && !options.force) {
    throw new LogAlreadyExistsError(dir);
  }
  const log: LogFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries: [],
  };
  writeLog(dir, log);
  return { created: true, path: dir };
}

export interface AddOptions {
  tag?: Tag;
}

export interface AddResult {
  entry: LogEntry;
  /**
   * True when neither `--tag` nor a configured `defaultTag` was given, and
   * the tag actually used came from the auto-tag keyword heuristic
   * (`autotag.ts`) instead of the hardcoded `"note"` fallback. Lets the CLI
   * surface an explicit "here's the tag I picked for you" notice instead of
   * silently guessing.
   */
  autoTagged: boolean;
}

/**
 * Logs a new entry. Tag resolution order: an explicit `--tag`, then a
 * configured `defaultTag` (`.friction-logrc.json`), then a best-effort
 * keyword-based suggestion (see `autotag.ts` — e.g. "broke"/"error" suggests
 * "friction", "worked"/"clean" suggests "worked-well", "wish"/"should"
 * suggests "feature-request"), and only once none of those apply does it
 * fall back to the hardcoded `"note"` default.
 */
export function add(dir: string, note: string, options: AddOptions = {}): AddResult {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new Error('Cannot add an empty note. Usage: friction-log add "some note" [--tag <tag>]');
  }
  const log = readLog(dir);
  const config = readConfig(dir);
  const explicitTag = options.tag && options.tag.trim().length > 0 ? options.tag.trim() : undefined;
  const configTag = config.defaultTag && config.defaultTag.trim().length > 0 ? config.defaultTag.trim() : undefined;
  const suggested = explicitTag === undefined && configTag === undefined ? suggestTag(trimmed) : undefined;
  const git = getGitInfo(dir);
  const entry: LogEntry = {
    id: generateEntryId(),
    timestamp: new Date().toISOString(),
    note: trimmed,
    tag: explicitTag ?? configTag ?? suggested ?? DEFAULT_TAG,
    ...(git ? { gitBranch: git.branch, gitCommit: git.commit } : {}),
  };
  log.entries.push(entry);
  writeLog(dir, log);
  return { entry, autoTagged: suggested !== undefined };
}

/**
 * Shared `--since`/`--until` handling for `list`/`export`/`stats`. Both
 * accept anything `Date.parse` can parse (a bare "2026-09-01", a full
 * ISO-8601 timestamp, etc.) and filtering happens *before* any tag
 * filtering, grouping, or aggregation — so `stats --since ... --tag ...`
 * would (if `stats` ever grew a `--tag`) always see the narrower set.
 *
 * A bare date-only `--until` (e.g. "2026-09-01", no time component) is
 * treated as the *end* of that day rather than midnight at its start, so
 * "--until 2026-09-01" reads naturally as "through the end of Sept 1", not
 * "up to the first instant of it". `--since` needs no such adjustment: a
 * bare date already means midnight at the start of that day, which is
 * exactly "from the start of Sept 1 onward".
 */
export interface DateRangeOptions {
  since?: string;
  until?: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateBoundary(label: "since" | "until", value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Could not parse --${label} "${value}" as a date.`);
  }
  if (label === "until" && DATE_ONLY_RE.test(trimmed)) {
    return parsed + 24 * 60 * 60 * 1000 - 1; // end of that day, inclusive
  }
  return parsed;
}

function filterByDateRange(entries: LogEntry[], options: DateRangeOptions): LogEntry[] {
  const since = parseDateBoundary("since", options.since);
  const until = parseDateBoundary("until", options.until);
  if (since === undefined && until === undefined) return entries;
  return entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    if (since !== undefined && t < since) return false;
    if (until !== undefined && t > until) return false;
    return true;
  });
}

export interface ListOptions extends DateRangeOptions {
  tag?: Tag;
}

/** Chronological order (oldest first) — matches the order entries were captured while building. */
export function list(dir: string, options: ListOptions = {}): LogEntry[] {
  const log = readLog(dir);
  const entries = filterByDateRange(log.entries, options);
  if (!options.tag) return entries;
  return entries.filter((e) => e.tag === options.tag);
}

export interface SearchOptions {
  tag?: Tag;
}

/**
 * Full-text search across each entry's note text: a case-insensitive
 * substring match (not a fuzzy or tokenized search — "line num" matches
 * "no line numbers" but "numbers line" would not), optionally narrowed to
 * one tag. Chronological order, same as `list`.
 */
export function search(dir: string, query: string, options: SearchOptions = {}): LogEntry[] {
  const log = readLog(dir);
  const needle = query.toLowerCase();
  return log.entries.filter((e) => {
    if (options.tag && e.tag !== options.tag) return false;
    return e.note.toLowerCase().includes(needle);
  });
}

export interface ExportOptions extends DateRangeOptions {
  out?: string;
  title?: string;
  format?: ExportFormat;
}

export function exportLog(dir: string, options: ExportOptions = {}): string {
  const log = readLog(dir);
  const config = readConfig(dir);
  const format = options.format ?? config.export?.format ?? "md";
  const title = options.title ?? config.export?.title;
  const out = options.out ?? config.export?.out;
  const filteredLog: LogFile = { ...log, entries: filterByDateRange(log.entries, options) };

  let content: string;
  switch (format) {
    case "json":
      content = exportJson(filteredLog);
      break;
    case "txt":
      content = exportText(filteredLog, { title });
      break;
    case "md":
      content = exportMarkdown(filteredLog, { title });
      break;
    case "timeline":
      content = exportTimeline(filteredLog, { title });
      break;
    default:
      throw new Error(`Unknown export format "${format}". Expected one of: json, md, txt, timeline.`);
  }

  if (out) {
    writeFileSync(out, content, "utf8");
  }
  return content;
}

export interface StatsResult {
  totalEntries: number;
  byTag: Record<string, number>;
  dateRange: { from: string; to: string } | null;
  busiestDay: { date: string; count: number } | null;
  /** Entry counts per calendar day (only days with >=1 entry), sorted chronologically — feeds the ASCII bar chart. */
  dailyCounts: DailyCount[];
}

/**
 * Summary stats over the log: counts per tag, date range covered, the
 * single busiest day, and a per-day breakdown (`dailyCounts`, rendered by
 * the CLI as a small ASCII bar chart). `since`/`until` narrow the entries
 * considered before any of the above is computed — e.g. `stats --since
 * 2026-09-02` reports only on "today's" session of a multi-day hackathon.
 */
export function stats(dir: string, options: DateRangeOptions = {}): StatsResult {
  const log = readLog(dir);
  const entries = filterByDateRange(log.entries, options);
  const byTag: Record<string, number> = {};
  const dayCounts: Record<string, number> = {};

  for (const entry of entries) {
    byTag[entry.tag] = (byTag[entry.tag] ?? 0) + 1;
    const day = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
  }

  let busiestDay: StatsResult["busiestDay"] = null;
  for (const [date, count] of Object.entries(dayCounts)) {
    if (!busiestDay || count > busiestDay.count) {
      busiestDay = { date, count };
    }
  }

  const dailyCounts: DailyCount[] = Object.entries(dayCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const dateRange =
    entries.length > 0 ? { from: entries[0].timestamp, to: entries[entries.length - 1].timestamp } : null;

  return { totalEntries: entries.length, byTag, dateRange, busiestDay, dailyCounts };
}

export interface EditOptions {
  note?: string;
  tag?: string;
}

/** Updates an existing entry's note and/or tag by id. Leaves fields not passed unchanged. */
export function editEntry(dir: string, id: string, options: EditOptions = {}): LogEntry {
  const log = readLog(dir);
  const entry = log.entries.find((e) => e.id === id);
  if (!entry) {
    throw new EntryNotFoundError(id);
  }
  if (options.note !== undefined) {
    const trimmed = options.note.trim();
    if (trimmed.length === 0) {
      throw new Error("Cannot set an empty note.");
    }
    entry.note = trimmed;
  }
  if (options.tag !== undefined) {
    const trimmed = options.tag.trim();
    entry.tag = trimmed.length > 0 ? trimmed : DEFAULT_TAG;
  }
  writeLog(dir, log);
  return entry;
}

/** Removes an entry by id. Throws EntryNotFoundError if no entry has that id. */
export function removeEntry(dir: string, id: string): LogEntry {
  const log = readLog(dir);
  const idx = log.entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    throw new EntryNotFoundError(id);
  }
  const [removed] = log.entries.splice(idx, 1);
  writeLog(dir, log);
  return removed;
}

export interface MergeResult {
  added: number;
  duplicates: number;
  total: number;
}

export interface MergeEntriesResult {
  entries: LogEntry[];
  added: number;
  duplicates: number;
}

/**
 * The id-based dedup logic shared by `merge` (two local files) and `sync`
 * (a local log and a remote's entries): starts from `target`, appends every
 * entry from `source` whose id isn't already present, and returns the
 * combined list re-sorted chronologically by timestamp. Pure — takes and
 * returns plain entry arrays, no file I/O — so both callers (and anything
 * standing in for a remote in a test) can reuse exactly this logic instead
 * of re-implementing "skip ids already seen" themselves.
 */
export function mergeEntries(target: LogEntry[], source: LogEntry[]): MergeEntriesResult {
  const seen = new Set(target.map((e) => e.id));
  const merged = target.slice();
  let added = 0;
  let duplicates = 0;

  for (const entry of source) {
    if (seen.has(entry.id)) {
      duplicates++;
      continue;
    }
    merged.push(entry);
    seen.add(entry.id);
    added++;
  }

  merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { entries: merged, added, duplicates };
}

/**
 * Merges entries from `sourcePath` (any `.friction-log.json`-shaped file)
 * into `targetPath`, de-duplicating by entry id (via `mergeEntries`) — so
 * running the same merge twice, or merging two logs that both descend from
 * a shared entry, doesn't double up entries. Entries are kept in
 * chronological (timestamp) order after merging, regardless of which file
 * they came from.
 */
export function merge(sourcePath: string, targetPath: string): MergeResult {
  if (!existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  if (!existsSync(targetPath)) {
    throw new Error(
      `Target file not found: ${targetPath}\n` +
        `Run "friction-log init" in the target directory first (or pass the path to an existing log file).`
    );
  }

  const source = readLogFile(sourcePath);
  const target = readLogFile(targetPath);

  const { entries, added, duplicates } = mergeEntries(target.entries, source.entries);
  writeLogFile(targetPath, { ...target, entries });

  return { added, duplicates, total: entries.length };
}

/**
 * Fills in a saved template's `{placeholder}` tokens with `values` and logs
 * the result as a normal entry via `add` — so it gets the same id
 * generation, git-aware tagging, and auto-tag fallback as any other `add`.
 * Tag resolution: `tagOverride` (the CLI's `--tag`) wins if given, else the
 * template's own saved tag, else `add`'s normal fallback chain (configured
 * `defaultTag`, then the auto-tag heuristic, then `"note"`).
 */
export function useTemplate(
  dir: string,
  name: string,
  values: Record<string, string>,
  tagOverride?: string
): AddResult {
  const template = getTemplate(dir, name);
  const filledNote = fillTemplate(template.text, values);
  return add(dir, filledNote, { tag: tagOverride ?? template.tag });
}

export interface TopOptions extends DateRangeOptions {
  /** How many top-scoring entries to return. Defaults to 5. */
  limit?: number;
}

/**
 * The highest-severity entries, highest first — see `severity.ts` for the
 * full scoring breakdown (tag weight + wording + recency, each individually
 * explained in `reasons`). This is the command to run right at submission
 * time to answer "what actually goes in the friction log section," instead
 * of re-reading every entry by hand.
 */
export function topEntries(dir: string, options: TopOptions = {}): SeverityBreakdown[] {
  const log = readLog(dir);
  const entries = filterByDateRange(log.entries, options);
  const scored = scoreEntries(entries);
  const limit = options.limit ?? 5;
  return scored.slice(0, Math.max(0, limit));
}

export interface GithubIssuesExportResult {
  outDir: string;
  files: string[];
  count: number;
}

/**
 * `friction-log export --format github-issues <owner/repo>` — builds the
 * issue files via `exporter.ts`'s `exportGithubIssues` (clustered by theme,
 * "worked-well" entries excluded since they aren't problems to file) and
 * writes each one under `outDir` (created if needed). Local-file export
 * only: no network call, no GitHub token involved anywhere in this path.
 */
export function exportGithubIssuesToFiles(
  dir: string,
  repo: string,
  outDir: string,
  options: DateRangeOptions = {}
): GithubIssuesExportResult {
  const log = readLog(dir);
  const filteredLog: LogFile = { ...log, entries: filterByDateRange(log.entries, options) };
  const files = buildGithubIssueFiles(filteredLog, repo);

  if (files.length > 0) {
    mkdirSync(outDir, { recursive: true });
    for (const file of files) {
      const content = `# ${file.title}\n\n${file.body}\n`;
      writeFileSync(join(outDir, file.filename), content, "utf8");
    }
  }

  return { outDir, files: files.map((f) => f.filename), count: files.length };
}
