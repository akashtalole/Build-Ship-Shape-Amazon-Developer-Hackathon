import type { Flashcard } from "./types.js";

/**
 * Portable flat export for flashcards — a plain TSV with a header row:
 * `front`, `back`, `tags` (space-separated, matching Anki's own multi-value
 * tag convention). TSV rather than CSV because flashcard text routinely
 * contains commas ("Mitochondria, the powerhouse of the cell") that would
 * otherwise need quoting/escaping; a raw tab is far less likely to appear in
 * generated flashcard text. Values are sanitized to strip any embedded tabs
 * or newlines so the row structure can't break.
 *
 * To import into Anki: File -> Import, choose "Fields separated by: Tab",
 * map column 1 -> Front, column 2 -> Back, column 3 -> Tags, and tell it to
 * skip the first line (it's a header, not a card).
 */
export function toPortableTsv(cards: Flashcard[]): string {
  const sanitize = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
  const header = ["front", "back", "tags"].join("\t");
  const rows = cards.map((c) => [sanitize(c.front), sanitize(c.back), (c.tags ?? []).join(" ")].join("\t"));
  return [header, ...rows].join("\n") + "\n";
}

/** One row parsed out of a portable TSV export — see `fromPortableTsv`. */
export interface ParsedTsvRow {
  front: string;
  back: string;
  tags: string[];
}

/**
 * The inverse of `toPortableTsv`: parses a TSV in that exact format (a
 * header row `front\tback\ttags`, tags space-separated) back into flashcard
 * rows, for `POST /import`'s round-trip with `GET /export`. The header row
 * is recognized case-insensitively and skipped if present, but isn't
 * required — a hand-trimmed body of just data rows still imports. Blank
 * lines are ignored. A line that doesn't split into exactly 3 tab-separated
 * fields, or whose `front`/`back` is empty after trimming, is skipped rather
 * than aborting the whole import — one malformed row shouldn't sink an
 * otherwise-good batch (deliberately looser than `toPortableTsv` is strict;
 * see FRICTION_LOG.md).
 */
export function fromPortableTsv(tsv: string): ParsedTsvRow[] {
  const lines = tsv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: ParsedTsvRow[] = [];

  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 3) continue;
    const [rawFront, rawBack, rawTags] = fields;
    if (
      rawFront.trim().toLowerCase() === "front" &&
      rawBack.trim().toLowerCase() === "back" &&
      rawTags.trim().toLowerCase() === "tags"
    ) {
      continue; // header row
    }
    const front = rawFront.trim();
    const back = rawBack.trim();
    if (!front || !back) continue;
    const tags = rawTags.trim() ? rawTags.trim().split(/\s+/) : [];
    rows.push({ front, back, tags });
  }

  return rows;
}
