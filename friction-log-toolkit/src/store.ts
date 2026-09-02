import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export function readLog(dir: string): LogFile {
  const path = logFilePath(dir);
  if (!existsSync(path)) {
    throw new LogNotFoundError(dir);
  }
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as LogFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      throw new Error("malformed");
    }
    return parsed;
  } catch {
    throw new Error(
      `Could not parse ${path} as a friction log. The file may be corrupted.`
    );
  }
}

export function writeLog(dir: string, log: LogFile): void {
  const path = logFilePath(dir);
  writeFileSync(path, JSON.stringify(log, null, 2) + "\n", "utf8");
}
