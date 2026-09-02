import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tag } from "./types.js";
import type { ExportFormat } from "./exporter.js";

export const CONFIG_FILE_NAME = ".friction-logrc.json";

export interface FrictionLogConfig {
  /** Used by `add` whenever `--tag` is omitted, instead of the hardcoded "note" default. */
  defaultTag?: Tag;
  export?: {
    /** Used by `export` whenever `--title` is omitted. */
    title?: string;
    /** Used by `export` whenever `--out` is omitted. */
    out?: string;
    /** Used by `export` whenever `--format` is omitted. */
    format?: ExportFormat;
  };
}

export function configFilePath(dir: string): string {
  return join(dir, CONFIG_FILE_NAME);
}

/**
 * Reads `.friction-logrc.json` from `dir`, if present. Returns `{}` (all
 * defaults absent) when there's no config file — an rc file is entirely
 * optional and every command works fine without one.
 *
 * Deliberately a *separate* file rather than a `config` block inside
 * `.friction-log.json`: the log file is per-machine working state (usually
 * gitignored, since it fills up with personal in-the-moment notes), while an
 * rc file holding team-wide defaults (a shared default tag, a standard
 * export title) is exactly the kind of thing you *do* want checked into the
 * repo — and separating them means a config choice never has to survive
 * being clobbered by `init --force` or read/written by every `add` call.
 */
export function readConfig(dir: string): FrictionLogConfig {
  const path = configFilePath(dir);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("malformed");
    }
    return parsed as FrictionLogConfig;
  } catch {
    throw new Error(
      `Could not parse ${path} as JSON.\n` +
        `Expected an object like {"defaultTag": "friction", "export": {"title": "...", "format": "md"}}.`
    );
  }
}
