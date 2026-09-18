import type { LogEntry } from "./types.js";
import { suggestTag } from "./autotag.js";

/**
 * Theme clustering — the engine behind `aggregate` (grouping teammates'
 * entries by shared problem, not just concatenating everyone's raw list)
 * and, indirectly, the `github-issues` and `timeline` export formats.
 *
 * Groups entries that are plausibly *about the same underlying problem* —
 * even when logged independently by different people, in different words —
 * using the exact same "no NLP, just keyword matching" philosophy as
 * `autotag.ts`'s `suggestTag` (in fact, `suggestTag` itself is reused below
 * as the fallback theme label for a cluster with no shared distinctive
 * words), applied to *significant words extracted from the notes
 * themselves* rather than a fixed list — the whole point is catching
 * domain-specific themes (e.g. "MCP schema validation") that could never be
 * hardcoded into a keyword list up front.
 */

export interface WordProfile {
  /** ALL-CAPS acronyms/initialisms found in the ORIGINAL (pre-lowercasing) text, e.g. "mcp", "aws" — a single shared acronym is strong enough evidence on its own to link two entries. */
  acronyms: Set<string>;
  /** Other significant (length >= 4, not a stopword) lowercase words — at least two shared words are required to link two entries, since any one common word alone is weaker evidence. */
  general: Set<string>;
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "has", "had", "were", "was", "are", "not",
  "but", "you", "your", "our", "its", "into", "about", "after", "before", "while",
  "when", "then", "than", "also", "just", "still", "even", "really", "should",
  "would", "could", "being", "been", "doing", "does", "did", "only", "some", "such",
  "more", "most", "very", "much", "many", "each", "other", "which", "what", "who",
  "whom", "where", "why", "how", "because", "since", "until", "over", "under",
  "again", "once", "here", "there", "all", "both", "few", "own", "same", "too",
  "will", "don", "won", "gave", "got", "get", "getting", "using", "used", "use",
  "tried", "trying", "went", "kept", "made", "make", "took", "them", "they", "their",
  "didn", "wasn", "doesn", "couldn", "wouldn", "shouldn", "one", "two", "out",
  "without", "within", "note", "notes", "logged", "logging", "entry", "entries",
  "friction", "feature", "request", "worked", "well", "kind", "sort", "around",
  "during", "time", "today", "yesterday", "thing", "things", "like", "back",
]);

const MIN_WORD_LENGTH = 4;

/** Extracts a word-profile from free text: ALL-CAPS acronyms kept as-is (case-folded), other significant words filtered by length + a small stopword list. */
export function profileOfText(text: string): WordProfile {
  const acronyms = new Set<string>();
  const acronymRe = /\b[A-Z]{2,}[0-9]*\b/g;
  let m: RegExpExecArray | null;
  while ((m = acronymRe.exec(text))) {
    acronyms.add(m[0].toLowerCase());
  }

  const general = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < MIN_WORD_LENGTH) continue;
    if (STOPWORDS.has(token)) continue;
    if (acronyms.has(token)) continue; // already counted as an acronym, don't double-count
    general.add(token);
  }

  return { acronyms, general };
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) {
    if (b.has(x)) out.add(x);
  }
  return out;
}

/** Two entries are "about the same theme" if they share at least one acronym, or at least two ordinary significant words. */
export function overlaps(a: WordProfile, b: WordProfile): boolean {
  return intersect(a.acronyms, b.acronyms).size >= 1 || intersect(a.general, b.general).size >= 2;
}

export interface ThemeCluster {
  /** Comma-joined significant words shared by every entry in the cluster — the human-readable "theme" label. */
  theme: string;
  entries: LogEntry[];
  /** The most common tag among the cluster's entries (ties broken by first occurrence). */
  dominantTag: string;
}

function dominantTagOf(entries: LogEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
  let best = entries[0].tag;
  let bestCount = 0;
  for (const e of entries) {
    const c = counts.get(e.tag) ?? 0;
    if (c > bestCount) {
      bestCount = c;
      best = e.tag;
    }
  }
  return best;
}

/**
 * Greedily groups `entries` into theme clusters: each cluster starts from
 * one ungrouped entry and absorbs every other ungrouped entry that overlaps
 * (see `overlaps`) with the cluster's *running* shared-word intersection —
 * narrowing that intersection on every addition — so a cluster's final
 * `theme` label is always words genuinely common to *every* member, not
 * just the seed entry's words. A cluster with no shared distinctive words at
 * all (a lone entry, or one whose note is too short/generic to extract
 * anything from) falls back to `suggestTag`'s keyword heuristic — reusing
 * the exact same auto-tag logic `add`/`watch` already use — so the theme
 * label is never blank.
 *
 * Clusters are returned largest-first (ties broken by the cluster's
 * earliest entry, chronologically), so the most significant recurring theme
 * leads the report.
 */
export function clusterByTheme(entries: LogEntry[]): ThemeCluster[] {
  const profiles = entries.map((entry) => ({ entry, profile: profileOfText(entry.note) }));
  const assigned = new Array(profiles.length).fill(false);
  const clusters: ThemeCluster[] = [];

  for (let i = 0; i < profiles.length; i++) {
    if (assigned[i]) continue;
    assigned[i] = true;
    let runningAcronyms = new Set(profiles[i].profile.acronyms);
    let runningGeneral = new Set(profiles[i].profile.general);
    const members = [profiles[i].entry];

    let addedInPass = true;
    while (addedInPass) {
      addedInPass = false;
      for (let j = 0; j < profiles.length; j++) {
        if (assigned[j]) continue;
        const candidate = profiles[j].profile;
        const sharedAcronyms = intersect(runningAcronyms, candidate.acronyms);
        const sharedGeneral = intersect(runningGeneral, candidate.general);
        if (sharedAcronyms.size >= 1 || sharedGeneral.size >= 2) {
          assigned[j] = true;
          members.push(profiles[j].entry);
          runningAcronyms = sharedAcronyms;
          runningGeneral = sharedGeneral;
          addedInPass = true;
        }
      }
    }

    const themeWords = [...runningAcronyms, ...runningGeneral].sort();
    const theme =
      themeWords.length > 0
        ? themeWords.join(", ")
        : (suggestTag(members.map((e) => e.note).join(" ")) ?? `misc (${dominantTagOf(members)})`);

    clusters.push({ theme, entries: members, dominantTag: dominantTagOf(members) });
  }

  clusters.sort((a, b) => {
    if (b.entries.length !== a.entries.length) return b.entries.length - a.entries.length;
    return a.entries[0].timestamp.localeCompare(b.entries[0].timestamp);
  });
  return clusters;
}
