#!/usr/bin/env node
import { resolve } from "node:path";
import { LogAlreadyExistsError, LogNotFoundError, logExists } from "./store.js";
import {
  EntryNotFoundError,
  add,
  editEntry,
  exportLog,
  init,
  list,
  merge,
  removeEntry,
  search,
  stats,
} from "./commands.js";
import { formatTimestamp } from "./exporter.js";
import type { ExportFormat } from "./exporter.js";
import { createFrictionLogServer } from "./server.js";
import { runWatch } from "./watch.js";

const USAGE = `friction-log — capture friction points in the moment, export them as a Markdown report.

Usage:
  friction-log init [--force]
  friction-log add "<note>" [--tag <tag>]
  friction-log list [--tag <tag>] [--since <date>] [--until <date>]
  friction-log search "<query>" [--tag <tag>]
  friction-log export [--out <file>] [--title <title>] [--format json|md|txt] [--since <date>] [--until <date>]
  friction-log stats [--since <date>] [--until <date>]
  friction-log edit <id> [--note <note>] [--tag <tag>]
  friction-log remove <id>
  friction-log merge <otherFile> --into <targetFile>
  friction-log serve [--port <port>]
  friction-log watch

Conventional tags (grouped specially by "export"):
  worked-well       something that went smoothly
  friction          something that slowed you down or broke
  feature-request   something you wish existed

Any other tag (or none, which defaults to "note", or a configured
"defaultTag" — see .friction-logrc.json below) lands under "Other notes" in
the exported report.

Config file (optional): a ".friction-logrc.json" in the current directory
supplies defaults that CLI flags always override:
  { "defaultTag": "friction", "export": { "title": "...", "out": "...", "format": "md" } }

Git-aware tagging: "add" automatically records the current branch and short
commit hash on the entry when run inside a git repo (silently omitted
otherwise — no error).

Date-range filtering: "--since"/"--until" on "list"/"export"/"stats" accept
anything JavaScript's Date.parse can read (e.g. "2026-09-01" or a full
ISO-8601 timestamp) and narrow entries to that range before any tag
filtering or grouping happens. A bare "--until 2026-09-01" (no time part)
means "through the end of that day", not its first instant.

"search" does a case-insensitive substring match against each entry's note
text (not fuzzy, not tokenized) — "line num" matches "no line numbers".

"serve" starts a local, dependency-free HTTP server (Ctrl-C to stop) showing
all entries, re-read from disk on every request, with a tag filter form.

"watch" is an interactive prompt-log-prompt loop for rapid-fire logging.
End a line with "#tagname" to tag it inline; a blank line, "exit", or "quit"
stops the loop.

Examples:
  friction-log init
  friction-log add "Alexa+ skill schema validation errors had no line numbers" --tag friction
  friction-log add "Ring API sandbox mode made local testing painless" --tag worked-well
  friction-log list --tag friction
  friction-log list --since 2026-09-02 --until 2026-09-02
  friction-log search "line numbers"
  friction-log search "docs" --tag friction
  friction-log export --out FRICTION_LOG.md --title "Team Rocket — Friction Log"
  friction-log export --format json --out entries.json
  friction-log stats --since 2026-09-02
  friction-log edit a1b2c3d4 --tag worked-well
  friction-log remove a1b2c3d4
  friction-log merge ../teammate/.friction-log.json --into .friction-log.json
  friction-log serve --port 4848
  friction-log watch
`;

/** Minimal, dependency-free argv parser: pulls out --flags (with values) and leaves positional args. */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`Error: ${message}\n`);
  console.error(USAGE);
  process.exitCode = 1;
  process.exit(1);
}

const VALID_FORMATS: ExportFormat[] = ["json", "md", "txt"];

export async function run(argv: string[], cwd: string = process.cwd()): Promise<void> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  try {
    switch (command) {
      case "init": {
        const result = init(cwd, { force: flags.force === true });
        console.log(`✓ Initialized friction log at ${result.path}/.friction-log.json`);
        break;
      }

      case "add": {
        const note = positional[0];
        if (!note) {
          fail('Missing note. Usage: friction-log add "<note>" [--tag <tag>]');
        }
        const tag = typeof flags.tag === "string" ? flags.tag : undefined;
        const entry = add(cwd, note, { tag });
        const gitSuffix = entry.gitBranch ? ` (${entry.gitBranch}@${entry.gitCommit})` : "";
        console.log(`✓ Logged [${entry.tag}] ${entry.note}${gitSuffix}`);
        break;
      }

      case "list": {
        const tag = typeof flags.tag === "string" ? flags.tag : undefined;
        const since = typeof flags.since === "string" ? flags.since : undefined;
        const until = typeof flags.until === "string" ? flags.until : undefined;
        const entries = list(cwd, { tag, since, until });
        if (entries.length === 0) {
          console.log(tag ? `No entries tagged "${tag}" in range.` : "No entries logged yet in range.");
          break;
        }
        for (const entry of entries) {
          console.log(`[${entry.tag}] ${entry.id}  ${entry.timestamp}  ${entry.note}`);
        }
        break;
      }

      case "search": {
        const query = positional[0];
        if (!query) {
          fail('Missing search query. Usage: friction-log search "<query>" [--tag <tag>]');
        }
        const tag = typeof flags.tag === "string" ? flags.tag : undefined;
        const results = search(cwd, query, { tag });
        if (results.length === 0) {
          console.log(
            tag ? `No entries matching "${query}" tagged "${tag}".` : `No entries matching "${query}".`
          );
          break;
        }
        console.log(
          `Found ${results.length} match${results.length === 1 ? "" : "es"} for "${query}"${
            tag ? ` (tag: ${tag})` : ""
          }:`
        );
        for (const entry of results) {
          console.log(`[${entry.tag}] ${entry.id}  ${entry.timestamp}  ${entry.note}`);
        }
        break;
      }

      case "export": {
        const out = typeof flags.out === "string" ? flags.out : undefined;
        const title = typeof flags.title === "string" ? flags.title : undefined;
        const formatFlag = typeof flags.format === "string" ? flags.format : undefined;
        const since = typeof flags.since === "string" ? flags.since : undefined;
        const until = typeof flags.until === "string" ? flags.until : undefined;
        if (formatFlag && !VALID_FORMATS.includes(formatFlag as ExportFormat)) {
          fail(`Unknown export format "${formatFlag}". Expected one of: ${VALID_FORMATS.join(", ")}.`);
        }
        const content = exportLog(cwd, {
          out,
          title,
          format: formatFlag as ExportFormat | undefined,
          since,
          until,
        });
        if (out) {
          console.log(`✓ Exported friction log to ${out}`);
        } else {
          console.log(content);
        }
        break;
      }

      case "stats": {
        const since = typeof flags.since === "string" ? flags.since : undefined;
        const until = typeof flags.until === "string" ? flags.until : undefined;
        const result = stats(cwd, { since, until });
        console.log("Friction Log Stats");
        console.log("-------------------");
        console.log(`Total entries: ${result.totalEntries}`);
        if (result.totalEntries === 0) {
          console.log("No entries logged yet.");
          break;
        }
        console.log("By tag:");
        for (const [tag, count] of Object.entries(result.byTag)) {
          console.log(`  ${tag}: ${count}`);
        }
        if (result.dateRange) {
          console.log(
            `Date range: ${formatTimestamp(result.dateRange.from)} -> ${formatTimestamp(result.dateRange.to)}`
          );
        }
        if (result.busiestDay) {
          console.log(
            `Busiest day: ${result.busiestDay.date} (${result.busiestDay.count} entr${
              result.busiestDay.count === 1 ? "y" : "ies"
            })`
          );
        }
        break;
      }

      case "edit": {
        const id = positional[0];
        if (!id) {
          fail("Missing entry id. Usage: friction-log edit <id> [--note <note>] [--tag <tag>]");
        }
        const note = typeof flags.note === "string" ? flags.note : undefined;
        const tag = typeof flags.tag === "string" ? flags.tag : undefined;
        if (note === undefined && tag === undefined) {
          fail("Nothing to edit. Pass --note and/or --tag.");
        }
        const entry = editEntry(cwd, id, { note, tag });
        console.log(`✓ Updated entry ${entry.id}: [${entry.tag}] ${entry.note}`);
        break;
      }

      case "remove": {
        const id = positional[0];
        if (!id) {
          fail("Missing entry id. Usage: friction-log remove <id>");
        }
        const entry = removeEntry(cwd, id);
        console.log(`✓ Removed entry ${entry.id}: [${entry.tag}] ${entry.note}`);
        break;
      }

      case "merge": {
        const sourceArg = positional[0];
        if (!sourceArg) {
          fail("Missing source file. Usage: friction-log merge <otherFile> --into <targetFile>");
        }
        const intoArg = typeof flags.into === "string" ? flags.into : undefined;
        if (!intoArg) {
          fail("Missing --into <targetFile>. Usage: friction-log merge <otherFile> --into <targetFile>");
        }
        const sourcePath = resolve(cwd, sourceArg);
        const targetPath = resolve(cwd, intoArg);
        const result = merge(sourcePath, targetPath);
        console.log(
          `✓ Merged ${sourcePath} into ${targetPath}: +${result.added} new, ${result.duplicates} duplicate(s) skipped, ${result.total} total.`
        );
        break;
      }

      case "serve": {
        if (!logExists(cwd)) {
          throw new LogNotFoundError(cwd);
        }
        let port = 4848;
        if (typeof flags.port === "string") {
          const parsed = Number(flags.port);
          if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
            fail(`Invalid --port "${flags.port}". Expected an integer between 0 and 65535.`);
          }
          port = parsed;
        }
        const server = createFrictionLogServer(cwd);
        await new Promise<void>((resolveListen) => {
          server.listen(port, () => {
            const address = server.address();
            const actualPort = address && typeof address !== "string" ? address.port : port;
            console.log(`✓ Friction log server running at http://localhost:${actualPort}/`);
            console.log("Press Ctrl-C to stop.");
            resolveListen();
          });
        });
        process.on("SIGINT", () => {
          console.log("\nStopping friction-log server.");
          server.close(() => process.exit(0));
        });
        // Keep the process alive on the open server handle — no explicit
        // await here, `serve` is meant to run until interrupted.
        break;
      }

      case "watch": {
        if (!logExists(cwd)) {
          throw new LogNotFoundError(cwd);
        }
        await runWatch(cwd);
        break;
      }

      case undefined:
      case "-h":
      case "--help":
      case "help": {
        console.log(USAGE);
        break;
      }

      default: {
        fail(`Unknown command "${command}".`);
      }
    }
  } catch (err) {
    if (
      err instanceof LogNotFoundError ||
      err instanceof LogAlreadyExistsError ||
      err instanceof EntryNotFoundError
    ) {
      fail(err.message);
    }
    if (err instanceof Error) {
      fail(err.message);
    }
    throw err;
  }
}

run(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
