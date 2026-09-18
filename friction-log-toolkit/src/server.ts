import { createServer, type Server } from "node:http";
import { readLog } from "./store.js";
import { formatTimestamp } from "./exporter.js";
import type { LogEntry } from "./types.js";

/**
 * A minimal, dependency-free local HTTP server (Node's built-in `http`
 * module only, no framework) that serves a single HTML page listing the
 * entries in the current directory's `.friction-log.json` — read fresh from
 * disk on *every* request (no caching), so `friction-log add` in one
 * terminal shows up on a page refresh in the browser with no restart
 * needed. Filtering by tag is a plain server-rendered `?tag=` query param,
 * driven by a `<select>` that submits a GET form — no client-side JS
 * required at all.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEntry(entry: LogEntry): string {
  const gitSuffix = entry.gitBranch
    ? `<span class="git">${escapeHtml(entry.gitBranch)}@${escapeHtml(entry.gitCommit ?? "")}</span>`
    : "";
  return `<li class="entry">
    <div class="entry-meta">
      <span class="tag">${escapeHtml(entry.tag)}</span>
      <span class="time">${escapeHtml(formatTimestamp(entry.timestamp))}</span>
      ${gitSuffix}
    </div>
    <p class="note">${escapeHtml(entry.note)}</p>
  </li>`;
}

/** Renders the full HTML page for `dir`, optionally narrowed to one tag. Re-reads the log file every call. */
export function renderFrictionLogPage(dir: string, tagFilter?: string): string {
  const log = readLog(dir);
  const allTags = Array.from(new Set(log.entries.map((e) => e.tag))).sort();
  const entries = tagFilter ? log.entries.filter((e) => e.tag === tagFilter) : log.entries;
  const newestFirst = entries.slice().reverse();

  const tagOptions = allTags
    .map(
      (tag) =>
        `<option value="${escapeHtml(tag)}"${tag === tagFilter ? " selected" : ""}>${escapeHtml(tag)}</option>`
    )
    .join("");

  const listHtml =
    newestFirst.length === 0
      ? `<p class="empty">${tagFilter ? `No entries tagged "${escapeHtml(tagFilter)}".` : "No entries logged yet."}</p>`
      : `<ul class="entries">${newestFirst.map(renderEntry).join("\n")}</ul>`;

  const subtitle = tagFilter
    ? `${entries.length} of ${log.entries.length} entries, tagged "${escapeHtml(tagFilter)}"`
    : `${log.entries.length} entr${log.entries.length === 1 ? "y" : "ies"} total`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Friction Log</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 760px;
    margin: 2.5rem auto;
    padding: 0 1.25rem;
    background: #fafaf9;
    color: #1c1917;
  }
  h1 { font-size: 1.5rem; margin-bottom: 0.15rem; }
  .subtitle { color: #78716c; margin-top: 0; margin-bottom: 1.25rem; font-size: 0.95rem; }
  form.filter {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
  }
  form.filter select {
    padding: 0.3rem 0.5rem;
    border-radius: 6px;
    border: 1px solid #d6d3d1;
    background: white;
  }
  form.filter a { color: #57534e; }
  ul.entries { list-style: none; margin: 0; padding: 0; }
  li.entry {
    background: white;
    border: 1px solid #e7e5e4;
    border-radius: 10px;
    padding: 0.75rem 1rem;
    margin-bottom: 0.6rem;
  }
  .entry-meta { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.78rem; }
  .tag {
    display: inline-block;
    background: #ecfccb;
    color: #365314;
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    font-weight: 600;
    text-transform: lowercase;
  }
  .time { color: #a8a29e; }
  .git { color: #a8a29e; font-family: ui-monospace, monospace; }
  p.note { margin: 0.4rem 0 0 0; line-height: 1.4; }
  p.empty { color: #78716c; font-style: italic; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #f5f5f4; }
    li.entry { background: #292524; border-color: #44403c; }
    form.filter select { background: #292524; border-color: #44403c; color: #f5f5f4; }
    .tag { background: #365314; color: #ecfccb; }
  }
</style>
</head>
<body>
  <h1>Friction Log</h1>
  <p class="subtitle">${subtitle} — auto-refreshes on reload, no caching</p>
  <form class="filter" method="get" action="/">
    <label for="tag">Filter by tag:</label>
    <select id="tag" name="tag" onchange="this.form.submit()">
      <option value="">All tags</option>
      ${tagOptions}
    </select>
    ${tagFilter ? `<a href="/">Clear filter</a>` : ""}
  </form>
  ${listHtml}
</body>
</html>
`;
}

/**
 * Builds (but does not start) the HTTP server. Kept separate from `.listen`
 * so tests can bind it to an ephemeral port (`server.listen(0)`) and read
 * back the actual port assigned.
 */
export function createFrictionLogServer(dir: string): Server {
  return createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found. Visit / to see the friction log.");
        return;
      }
      const tagFilter = url.searchParams.get("tag")?.trim() || undefined;
      const html = renderFrictionLogPage(dir, tagFilter);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
