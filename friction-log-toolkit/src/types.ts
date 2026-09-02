/**
 * Core shapes for the friction-log store.
 *
 * The three tags below are the ones the exporter groups specially into the
 * headings a hackathon FRICTION_LOG.md is expected to have. Any other string
 * is a valid tag too (including the default "note") — it just lands under
 * "Other notes" in the exported report.
 */
export type WellKnownTag = "worked-well" | "friction" | "feature-request";

/** Any tag is allowed; these three are recognized for special grouping. */
export type Tag = WellKnownTag | (string & {});

export const DEFAULT_TAG: Tag = "note";

export interface LogEntry {
  /**
   * Short stable identifier used to target an entry with `edit`/`remove`, and
   * to de-duplicate entries across files with `merge`. Entries created before
   * this field existed are backfilled with one (and the file rewritten to
   * persist it) the first time the log is read — see `store.ts`.
   */
  id: string;
  /** ISO-8601 timestamp, set at creation time and never modified. */
  timestamp: string;
  /** The free-text note the developer typed in the moment. */
  note: string;
  /** Tag used to group the entry in list output and the exported report. */
  tag: Tag;
  /** Current branch name, captured automatically at `add` time if run inside a git repo. */
  gitBranch?: string;
  /** Short commit hash, captured automatically at `add` time if run inside a git repo. */
  gitCommit?: string;
}

export interface LogFile {
  /** Schema version, so a future release can migrate older log files. */
  version: 1;
  /** ISO-8601 timestamp of when `init` created this log. */
  createdAt: string;
  entries: LogEntry[];
}
