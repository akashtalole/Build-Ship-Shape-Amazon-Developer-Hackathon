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
