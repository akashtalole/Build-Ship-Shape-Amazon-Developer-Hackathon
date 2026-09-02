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
  /** ISO-8601 timestamp, set at creation time and never modified. */
  timestamp: string;
  /** The free-text note the developer typed in the moment. */
  note: string;
  /** Tag used to group the entry in list output and the exported report. */
  tag: Tag;
}

export interface LogFile {
  /** Schema version, so a future release can migrate older log files. */
  version: 1;
  /** ISO-8601 timestamp of when `init` created this log. */
  createdAt: string;
  entries: LogEntry[];
}
