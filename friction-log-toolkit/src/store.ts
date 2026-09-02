import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { LogFile } from "./types.js";

export const LOG_FILE_NAME = ".friction-log.json";

export class LogNotFoundError extends Error {
  constructor(dir: string) {
    super(
      `No friction log found in ${dir} (missing ${LOG_FILE_NAME}).\n` +
        `Run "friction-log init" first to create one.`
    );
    this.name = "LogNotFoundError";
  }
}

export class LogAlreadyExistsError extends Error {
  constructor(dir: string) {
    super(
      `A friction log already exists in ${dir} (${LOG_FILE_NAME}).\n` +
        `Re-run with --force to overwrite it, or edit/delete the file yourself.`
    );
    this.name = "LogAlreadyExistsError";
  }
}

export function logFilePath(dir: string): string {
  return join(dir, LOG_FILE_NAME);
}

export function logExists(dir: string): boolean {
  return existsSync(logFilePath(dir));
}

/** Generates a short, URL/shell-safe id (8 hex chars) for a new entry. */
export function generateEntryId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Older log files (schema-compatible, just written before `id` existed on
 * `LogEntry`) don't have per-entry ids. Rather than bump the schema version
 * or fail to load them, we backfill an id for any entry missing one the
 * first time the file is read, and persist that backfill immediately so the
 * ids a user sees in `list` stay stable across subsequent reads (important
 * once `edit`/`remove` let you reference an entry by id).
 */
function backfillIds(log: LogFile): { log: LogFile; changed: boolean } {
  let changed = false;
  const usedIds = new Set(log.entries.filter((e) => e.id).map((e) => e.id));
  const entries = log.entries.map((e) => {
    if (e.id) return e;
    changed = true;
    let id = generateEntryId();
    while (usedIds.has(id)) id = generateEntryId();
    usedIds.add(id);
    return { ...e, id };
  });
  return { log: changed ? { ...log, entries } : log, changed };
}

function parseLogFile(path: string, raw: string): LogFile {
  let parsed: LogFile;
  try {
    parsed = JSON.parse(raw) as LogFile;
  } catch {
    throw new Error(
      `Could not parse ${path} as a friction log. The file may be corrupted.`
    );
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(
      `Could not parse ${path} as a friction log. The file may be corrupted.`
    );
  }
  return parsed;
}

/**
 * Reads any `.friction-log.json`-shaped file by explicit path, regardless of
 * its filename — used by `merge`, which needs to read a teammate's log file
 * that isn't necessarily sitting in the current directory under the
 * conventional name.
 */
export function readLogFile(path: string): LogFile {
  if (!existsSync(path)) {
    throw new Error(`No friction log file found at ${path}.`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parseLogFile(path, raw);
  const { log, changed } = backfillIds(parsed);
  if (changed) writeLogFile(path, log);
  return log;
}

export function writeLogFile(path: string, log: LogFile): void {
  writeFileSync(path, JSON.stringify(log, null, 2) + "\n", "utf8");
}

export function readLog(dir: string): LogFile {
  const path = logFilePath(dir);
  if (!existsSync(path)) {
    throw new LogNotFoundError(dir);
  }
  return readLogFile(path);
}

export function writeLog(dir: string, log: LogFile): void {
  writeLogFile(logFilePath(dir), log);
}
