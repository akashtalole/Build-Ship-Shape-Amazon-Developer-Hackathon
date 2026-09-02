import { writeFileSync } from "node:fs";
import {
  LogAlreadyExistsError,
  logExists,
  readLog,
  writeLog,
} from "./store.js";
import { exportMarkdown } from "./exporter.js";
import { DEFAULT_TAG, type LogEntry, type LogFile, type Tag } from "./types.js";

/**
 * Command implementations, decoupled from argv parsing so they can be unit
 * tested directly (as the smoke test does) without shelling out.
 */

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
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    note: trimmed,
    tag: options.tag && options.tag.trim().length > 0 ? options.tag.trim() : DEFAULT_TAG,
  };
  log.entries.push(entry);
  writeLog(dir, log);
  return entry;
}

export interface ListOptions {
  tag?: Tag;
}

/** Chronological order (oldest first) — matches the order entries were captured while building. */
export function list(dir: string, options: ListOptions = {}): LogEntry[] {
  const log = readLog(dir);
  if (!options.tag) return log.entries;
  return log.entries.filter((e) => e.tag === options.tag);
}

export interface ExportOptions {
  out?: string;
  title?: string;
}

export function exportLog(dir: string, options: ExportOptions = {}): string {
  const log = readLog(dir);
  const markdown = exportMarkdown(log, { title: options.title });
  if (options.out) {
    writeFileSync(options.out, markdown, "utf8");
  }
  return markdown;
}
