#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LogAlreadyExistsError, LogNotFoundError, logExists } from "./store.js";
import {
  EntryNotFoundError,
  add,
  editEntry,
  exportGithubIssuesToFiles,
  exportLog,
  init,
  list,
  merge,
  removeEntry,
  search,
  stats,
  topEntries,
  useTemplate,
} from "./commands.js";
import { addTemplate, listTemplates, TemplateNotFoundError } from "./templates.js";
import { formatAggregateReport, formatTimestamp } from "./exporter.js";
import type { ExportFormat } from "./exporter.js";
import { renderBarChart } from "./chart.js";
import { createFrictionLogServer } from "./server.js";
import { runWatch } from "./watch.js";
import { pullSync, pushSync } from "./sync.js";
import { aggregate } from "./aggregate.js";

const USAGE = `friction-log — capture friction points in the moment, export them as a Markdown report.

Usage:
  friction-log init [--force]
  friction-log add "<note>" [--tag <tag>]
  friction-log list [--tag <tag>] [--since <date>] [--until <date>]
  friction-log search "<query>" [--tag <tag>]
  friction-log export [--out <file>] [--title <title>] [--format json|md|txt|timeline] [--since <date>] [--until <date>]
  friction-log export --format github-issues <owner/repo> [--out <dir>] [--since <date>] [--until <date>]
  friction-log stats [--since <date>] [--until <date>]
  friction-log top [N] [--since <date>] [--until <date>]
  friction-log edit <id> [--note <note>] [--tag <tag>]
  friction-log remove <id>
  friction-log merge <otherFile> --into <targetFile>
  friction-log sync <url> [--push|--pull]
  friction-log aggregate <url1> <url2> ... [--out <file>] [--title <title>]
  friction-log template add <name> "<text with {placeholders}>" [--tag <tag>]
  friction-log template use <name> [--set key=value ...] [--tag <tag>]
  friction-log template list
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

Auto-tag suggestion: "add"/"watch" with no explicit tag (and no configured
"defaultTag") suggest one from keywords in the note text — "bug"/"broke"/
"error"/"crash"/"fail"/"confusing"/"stuck" suggest "friction"; "worked"/
"nice"/"clean"/"smooth"/"great"/"easy"/"painless" suggest "worked-well";
"should"/"wish"/"would be nice"/"could use"/"want" suggest "feature-request".
"add" applies the suggestion automatically and says so in its output;
"watch" prompts for confirmation (Enter accepts it, or type a different
tag). No match falls back to "note", exactly as before this feature existed.

"sync <url> [--push|--pull]" exchanges entries with a remote over a simple
JSON HTTP contract (GET returns "{entries: [...]}", POST accepts the same
shape and returns "{added, duplicates, total}") using the same id-based
dedup as "merge", so it's safe to run repeatedly. Exactly one of --push
(send local entries) or --pull (fetch and merge remote entries into the
local log) must be given.

"template add <name> \"<text>\"" saves a reusable note with {placeholder}
tokens (e.g. "Docs for {feature} were unclear"); "template use <name>
--set key=value ..." fills them in and logs the result like a normal "add",
using the template's own --tag (if it has one) unless overridden by --tag
on "use"; "template list" shows what's saved.

"top [N]" scores every entry with a real, explainable severity heuristic
(tag weight + blocker/crash/dead-end wording in the note text, minus
"minor"/"cosmetic"-style hedging, plus a recency bonus for entries still
fresh near a deadline) and prints the N highest-scoring entries first (N
defaults to 5), each with the reasons behind its score — the command to run
right before writing the submission's own friction-log section instead of
re-reading the whole log by hand.

"aggregate <url1> <url2> ..." pulls entries from multiple teammates'
running instances (over the same GET half of the "sync" HTTP contract, so
anything already answering "sync" works here too), merges them with the
same id-based dedup "merge"/"sync" use, and groups the combined set by
shared theme — reusing the auto-tag keyword heuristic as a fallback label —
so several people independently hitting the same underlying problem show up
as one grouped theme instead of a flat concatenation of everyone's list.

"export --format timeline" turns the log into chronological narrative
prose instead of a bulleted list: consecutive same-tag entries are folded
into one paragraph ("friction showed up more than once: first X, then Y"),
and a "worked-well" paragraph that shares wording with an earlier
"friction" one is phrased as a resolution. Entirely template-based and
deterministic (no LLM call) — suitable for pasting into a Devpost-style
"challenges we ran into" section.

"export --format github-issues <owner/repo>" writes one Markdown file per
theme cluster of actionable entries (everything except "worked-well") to
--out (a directory, default "./github-issues"), formatted as a ready-to-file
GitHub issue body. This is LOCAL FILE EXPORT ONLY: it never calls the
GitHub API and needs no token — review the files, then run e.g.
"gh issue create -R <owner/repo> --title \"...\" --body-file <file>" or paste
the content into the GitHub UI yourself.

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
  friction-log top 3
  friction-log edit a1b2c3d4 --tag worked-well
  friction-log remove a1b2c3d4
  friction-log merge ../teammate/.friction-log.json --into .friction-log.json
  friction-log sync https://example.com/friction-log --push
  friction-log sync https://example.com/friction-log --pull
  friction-log aggregate https://teammate-a.example.com/friction-log https://teammate-b.example.com/friction-log
  friction-log export --format timeline --out TIMELINE.md
  friction-log export --format github-issues my-org/my-repo --out github-issues
  friction-log template add flaky-endpoint "{endpoint} returned {code} with no explanation" --tag friction
  friction-log template use flaky-endpoint --set endpoint=/v1/token --set code=500
  friction-log template list
  friction-log serve --port 4848
  friction-log watch
`;

/**
 * Minimal, dependency-free argv parser: pulls out --flags (with values) and
 * leaves positional args. A flag repeated with string values (only
 * `--set key=value` needs this, for `template use`) collects into a
 * `string[]` instead of the later occurrence silently clobbering the
 * earlier one; every other flag keeps its original single-value behavior
 * since nothing else in this CLI is ever passed more than once.
 */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean | string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      let value: string | boolean;
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
      const existing = flags[key];
      if (existing === undefined) {
        flags[key] = value;
      } else if (Array.isArray(existing) && typeof value === "string") {
        existing.push(value);
      } else if (typeof existing === "string" && typeof value === "string") {
        flags[key] = [existing, value];
      } else {
        flags[key] = value;
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

const VALID_FORMATS: ExportFormat[] = ["json", "md", "txt", "timeline"];
/** "github-issues" writes multiple files to a directory (not a single string), so it's validated alongside the single-content formats above but handled as its own branch in the "export" case below. */
const GITHUB_ISSUES_FORMAT = "github-issues";
const OWNER_REPO_RE = /^[^\s/]+\/[^\s/]+$/;

/**
 * Renders the "✓ Logged [...] ..." confirmation shared by `add` and
 * `template use`. When the tag came from the auto-tag heuristic (no
 * explicit `--tag`, no configured `defaultTag`, but a keyword matched),
 * says so explicitly — a non-interactive `add` applies the suggestion
 * automatically, so it must never look like a silent surprise.
 */
function formatAddConfirmation(result: { entry: { tag: string; note: string; gitBranch?: string; gitCommit?: string }; autoTagged: boolean }): string {
  const { entry, autoTagged } = result;
  const gitSuffix = entry.gitBranch ? ` (${entry.gitBranch}@${entry.gitCommit})` : "";
  const autoSuffix = autoTagged ? ` (auto-tagged "${entry.tag}" based on the note text — override any time with --tag)` : "";
  return `✓ Logged [${entry.tag}] ${entry.note}${gitSuffix}${autoSuffix}`;
}

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
        const result = add(cwd, note, { tag });
        console.log(formatAddConfirmation(result));
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
        if (formatFlag && formatFlag !== GITHUB_ISSUES_FORMAT && !VALID_FORMATS.includes(formatFlag as ExportFormat)) {
          fail(
            `Unknown export format "${formatFlag}". Expected one of: ${VALID_FORMATS.join(", ")}, ${GITHUB_ISSUES_FORMAT}.`
          );
        }

        if (formatFlag === GITHUB_ISSUES_FORMAT) {
          const repo = positional[0];
          if (!repo || !OWNER_REPO_RE.test(repo)) {
            fail(
              'Missing or invalid <owner/repo>. Usage: friction-log export --format github-issues <owner/repo> [--out <dir>]'
            );
          }
          const outDir = out ?? "github-issues";
          const result = exportGithubIssuesToFiles(cwd, repo, outDir, { since, until });
          if (result.count === 0) {
            console.log(
              'No friction/feature-request (or other non-"worked-well") entries to export — nothing written.'
            );
          } else {
            console.log(`✓ Wrote ${result.count} GitHub issue file(s) to ${outDir}/ for ${repo}.`);
            console.log(
              "This is LOCAL FILE EXPORT ONLY — nothing was filed on GitHub. Review each file, then run e.g.:"
            );
            console.log(`  gh issue create -R ${repo} --title "..." --body-file ${outDir}/${result.files[0]}`);
          }
          break;
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
        if (result.dailyCounts.length > 0) {
          console.log("Daily activity:");
          for (const line of renderBarChart(result.dailyCounts)) {
            console.log(`  ${line}`);
          }
        }
        break;
      }

      case "top": {
        const nArg = positional[0];
        let limit = 5;
        if (nArg !== undefined) {
          const parsed = Number(nArg);
          if (!Number.isInteger(parsed) || parsed < 1) {
            fail(`Invalid N "${nArg}". Expected a positive integer. Usage: friction-log top [N]`);
          }
          limit = parsed;
        }
        const since = typeof flags.since === "string" ? flags.since : undefined;
        const until = typeof flags.until === "string" ? flags.until : undefined;
        const results = topEntries(cwd, { limit, since, until });
        if (results.length === 0) {
          console.log("No entries logged yet in range.");
          break;
        }
        console.log(`Top ${results.length} entr${results.length === 1 ? "y" : "ies"} by severity score:`);
        results.forEach((r, i) => {
          console.log(`${i + 1}. [score ${r.total}] [${r.entry.tag}] ${r.entry.note}`);
          for (const reason of r.reasons) {
            console.log(`     - ${reason}`);
          }
        });
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

      case "sync": {
        const url = positional[0];
        if (!url) {
          fail("Missing URL. Usage: friction-log sync <url> [--push|--pull]");
        }
        if (!logExists(cwd)) {
          throw new LogNotFoundError(cwd);
        }
        const wantsPush = flags.push === true;
        const wantsPull = flags.pull === true;
        if (wantsPush === wantsPull) {
          fail("Specify exactly one of --push or --pull. Usage: friction-log sync <url> [--push|--pull]");
        }
        if (wantsPush) {
          const result = await pushSync(cwd, url);
          console.log(
            `✓ Pushed to ${url}: +${result.added} new, ${result.duplicates} duplicate(s) skipped, ${result.total} total on remote.`
          );
        } else {
          const result = await pullSync(cwd, url);
          console.log(
            `✓ Pulled from ${url}: +${result.added} new, ${result.duplicates} duplicate(s) skipped, ${result.total} total locally.`
          );
        }
        break;
      }

      case "aggregate": {
        const urls = positional;
        if (urls.length === 0) {
          fail("Missing remote URL(s). Usage: friction-log aggregate <url1> <url2> ...");
        }
        const out = typeof flags.out === "string" ? flags.out : undefined;
        const title = typeof flags.title === "string" ? flags.title : undefined;
        const report = await aggregate(urls);
        const content = formatAggregateReport(report, { title });
        if (out) {
          writeFileSync(out, content, "utf8");
          console.log(
            `✓ Aggregated ${report.totalEntries} entries from ${urls.length} source(s) into ${report.clusters.length} theme(s), written to ${out}`
          );
        } else {
          console.log(content);
        }
        break;
      }

      case "template": {
        const sub = positional[0];
        switch (sub) {
          case "add": {
            const name = positional[1];
            const text = positional[2];
            if (!name || !text) {
              fail(
                'Missing name or text. Usage: friction-log template add <name> "<text with {placeholders}>" [--tag <tag>]'
              );
            }
            const tag = typeof flags.tag === "string" ? flags.tag : undefined;
            const template = addTemplate(cwd, name, text, tag);
            const tagSuffix = template.tag ? ` (tag: ${template.tag})` : "";
            console.log(`✓ Saved template "${template.name}"${tagSuffix}: ${template.text}`);
            break;
          }

          case "use": {
            const name = positional[1];
            if (!name) {
              fail("Missing template name. Usage: friction-log template use <name> [--set key=value ...] [--tag <tag>]");
            }
            const setRaw = flags.set;
            const setValues = Array.isArray(setRaw) ? setRaw : typeof setRaw === "string" ? [setRaw] : [];
            const values: Record<string, string> = {};
            for (const raw of setValues) {
              const eqIndex = raw.indexOf("=");
              if (eqIndex === -1) {
                fail(`Invalid --set "${raw}". Expected key=value.`);
              }
              values[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1);
            }
            const tagOverride = typeof flags.tag === "string" ? flags.tag : undefined;
            const result = useTemplate(cwd, name, values, tagOverride);
            console.log(formatAddConfirmation(result));
            break;
          }

          case "list": {
            const templates = listTemplates(cwd);
            if (templates.length === 0) {
              console.log("No templates saved yet.");
              break;
            }
            for (const template of templates) {
              const tagSuffix = template.tag ? ` [${template.tag}]` : "";
              console.log(`${template.name}${tagSuffix}: ${template.text}`);
            }
            break;
          }

          default: {
            fail(`Unknown template subcommand "${sub}". Expected "add", "use", or "list".`);
          }
        }
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
      err instanceof EntryNotFoundError ||
      err instanceof TemplateNotFoundError
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
