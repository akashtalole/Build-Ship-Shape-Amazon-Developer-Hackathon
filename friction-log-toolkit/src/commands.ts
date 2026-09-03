import { existsSync, writeFileSync } from "node:fs";
import {
  LogAlreadyExistsError,
  generateEntryId,
  logExists,
  readLog,
  readLogFile,
  writeLog,
  writeLogFile,
} from "./store.js";
import { exportJson, exportMarkdown, exportText, type ExportFormat } from "./exporter.js";
import { readConfig } from "./config.js";
import { getGitInfo } from "./git.js";
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

export function add(dir: string, note: string, options: AddOptions = {}): LogEntry {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new Error('Cannot add an empty note. Usage: friction-log add "some note" [--tag <tag>]');
  }
  const log = readLog(dir);
  const config = readConfig(dir);
  const explicitTag = options.tag && options.tag.trim().length > 0 ? options.tag.trim() : undefined;
  const configTag = config.defaultTag && config.defaultTag.trim().length > 0 ? config.defaultTag.trim() : undefined;
  const git = getGitInfo(dir);
  const entry: LogEntry = {
    id: generateEntryId(),
    timestamp: new Date().toISOString(),
    note: trimmed,
    tag: explicitTag ?? configTag ?? DEFAULT_TAG,
    ...(git ? { gitBranch: git.branch, gitCommit: git.commit } : {}),
  };
  log.entries.push(entry);
  writeLog(dir, log);
  return entry;
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
    default:
      throw new Error(`Unknown export format "${format}". Expected one of: json, md, txt.`);
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
}

/**
 * Summary stats over the log: counts per tag, date range covered, and the
 * single busiest day. `since`/`until` narrow the entries considered before
 * any of the above is computed — e.g. `stats --since 2026-09-02` reports
 * only on "today's" session of a multi-day hackathon.
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

  const dateRange =
    entries.length > 0 ? { from: entries[0].timestamp, to: entries[entries.length - 1].timestamp } : null;

  return { totalEntries: entries.length, byTag, dateRange, busiestDay };
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

/**
 * Merges entries from `sourcePath` (any `.friction-log.json`-shaped file)
 * into `targetPath`, de-duplicating by entry id — so running the same merge
 * twice, or merging two logs that both descend from a shared entry, doesn't
 * double up entries. Entries are kept in chronological (timestamp) order
 * after merging, regardless of which file they came from.
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

  const seen = new Set(target.entries.map((e) => e.id));
  let added = 0;
  let duplicates = 0;

  for (const entry of source.entries) {
    if (seen.has(entry.id)) {
      duplicates++;
      continue;
    }
    target.entries.push(entry);
    seen.add(entry.id);
    added++;
  }

  target.entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  writeLogFile(targetPath, target);

  return { added, duplicates, total: target.entries.length };
}
