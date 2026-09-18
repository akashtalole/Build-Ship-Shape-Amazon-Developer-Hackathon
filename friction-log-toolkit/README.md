# friction-log-toolkit

A tiny CLI for capturing friction points **in the moment** while you build, and exporting them as a structured Markdown friction log.

## The problem it solves

The Build, Ship, Shape: Amazon Developer Hackathon explicitly rewards friction logs — a well-written `FRICTION_LOG.md` covering what worked, what didn't, and what you'd ask the platform team to fix can earn up to a **10% judging bonus**. But in practice, friction logs get written from memory an hour before submission, after the specific error messages, dead-end docs pages, and "wish this existed" moments have already been forgotten.

`friction-log-toolkit` fixes that by making logging a friction point as cheap as a single terminal command, right when it happens:

```
friction-log add "Alexa+ skill schema validation errors had no line numbers" --tag friction
```

Then, at submission time, one command turns everything you captured into a structured Markdown report in the same "What worked well / Friction encountered / Feature requests" shape used elsewhere in this repo (see `alexa-homeops-mcp/FRICTION_LOG.md` and `ring-porchpass/FRICTION_LOG.md`).

## Installation & usage

```bash
cd friction-log-toolkit
npm install
npm run build
```

Then either:

- **Link it globally** so `friction-log` is on your `PATH`:

  ```bash
  npm link
  friction-log init
  ```

- **Or run it directly** without linking:

  ```bash
  node dist/cli.js init
  ```

- **Or run it without a separate build step** via `npx .` from this directory (npm will run `prepare`-less local install and use the `bin` entry once built), or during development with `npm run dev -- <command>` (uses `tsx` against the TypeScript source directly, no build needed).

Run it from inside whatever project directory you're building your hackathon submission in — `friction-log init` creates a `.friction-log.json` log store right there, next to your project's code.

## Command reference

### `friction-log init [--force]`

Creates a `.friction-log.json` file in the current directory. Refuses to overwrite an existing one unless you pass `--force`.

```bash
$ friction-log init
✓ Initialized friction log at /home/you/my-hackathon-project/.friction-log.json

$ friction-log init
Error: A friction log already exists in /home/you/my-hackathon-project (.friction-log.json).
Re-run with --force to overwrite it, or edit/delete the file yourself.
```

### `friction-log add "<note>" [--tag <tag>]`

Appends a timestamped entry. `--tag` is optional; entries with no tag default to `note`.

Three tags are treated specially by `export` (any other string is still a valid tag, it just lands under "Other notes"):

| Tag | Meaning |
|---|---|
| `worked-well` | Something that went smoothly |
| `friction` | Something that slowed you down, confused you, or broke |
| `feature-request` | Something you wish the platform/SDK/docs had |

```bash
$ friction-log add "Ring API sandbox mode made local testing painless" --tag worked-well
✓ Logged [worked-well] Ring API sandbox mode made local testing painless

$ friction-log add "OAuth token refresh docs were split across three pages" --tag friction
✓ Logged [friction] OAuth token refresh docs were split across three pages
```

**Git-aware tagging**: if the current directory is inside a git repository, `add` automatically captures the current branch name and short commit hash and stores them on the entry as `gitBranch`/`gitCommit` — purely informational, useful later for correlating a friction point with what was actually being built at the time:

```bash
$ friction-log add "Schema validation errors had no line numbers" --tag friction
✓ Logged [friction] Schema validation errors had no line numbers (feature/alexa-skill@a1b2c3d)
```

Outside a git repo (or if `git` isn't installed, or the repo has no commits yet), this is a silent no-op — no error, the entry is just saved without those two fields, exactly like before this feature existed.

**Config-file default tag**: see [`friction-log defaultTag`](#config-file-friction-logrcjson) below — if `--tag` is omitted *and* a `.friction-logrc.json` sets `"defaultTag"`, that's used instead of the hardcoded `"note"` fallback.

**Auto-tag suggestion**: if `--tag` is omitted *and* no `defaultTag` is configured, `add` tries a simple keyword heuristic against the note text before falling back to `"note"` — see [Auto-tag suggestion](#auto-tag-suggestion) below. When it fires, the confirmation line says so explicitly, so the tag it picked is never a silent surprise:

```bash
$ friction-log add "The Alexa+ emulator broke during setup"
✓ Logged [friction] The Alexa+ emulator broke during setup (auto-tagged "friction" based on the note text — override any time with --tag)
```

### `friction-log list [--tag <tag>] [--since <date>] [--until <date>]`

Prints entries to stdout in chronological order (oldest first — the order you captured them while building), optionally filtered to one tag. Each line includes the entry's short id, needed for `edit`/`remove`.

```bash
$ friction-log list --tag friction
[friction] a1b2c3d4  2026-09-02T09:14:03.112Z  OAuth token refresh docs were split across three pages
[friction] e5f6a7b8  2026-09-02T10:02:47.881Z  Alexa+ skill manifest schema errors gave no line numbers
```

**Date-range filtering** — see [Date-range filtering](#date-range-filtering---since--until) below.

### `friction-log search "<query>" [--tag <tag>]`

Full-text search over entry notes: a **case-insensitive substring match** (not fuzzy, not tokenized — `"line num"` matches `"had no line numbers"`, but `"numbers line"` would not). Optionally narrow to one tag with `--tag`, same as `list`. Output includes enough context to be useful without re-running `list`: the tag, id, timestamp, and full note text for every match.

```bash
$ friction-log search "line numbers"
Found 1 match for "line numbers":
[friction] a1b2c3d4  2026-09-02T09:14:03.112Z  Alexa+ skill manifest schema errors gave no line numbers

$ friction-log search "docs" --tag friction
Found 1 match for "docs" (tag: friction):
[friction] e5f6a7b8  2026-09-02T10:02:47.881Z  OAuth token refresh docs were split across three pages

$ friction-log search "nothing matches this"
No entries matching "nothing matches this".
```

### `friction-log stats [--since <date>] [--until <date>]`

A quick summary: total entries, a breakdown per tag, the date range covered, which single day had the most entries logged, and a small ASCII bar chart of entries per day. Just a fast mid-hackathon check-in on how much you've captured so far.

```bash
$ friction-log stats
Friction Log Stats
-------------------
Total entries: 7
By tag:
  worked-well: 2
  friction: 3
  feature-request: 1
  note: 1
Date range: 2026-09-01 14:02 UTC -> 2026-09-02 12:28 UTC
Busiest day: 2026-09-02 (5 entries)
Daily activity:
  2026-09-01 |██ 2
  2026-09-02 |█████ 5
```

**The bar chart** (`Daily activity`) prints one line per calendar day that has at least one entry (a log spanning a huge date range with long empty gaps doesn't print a wall of zero-count days), in chronological order. Below 40 entries in a single day, a bar is exactly `count` block characters (`█`) long, so the bar itself is an exact, at-a-glance count — not just decoration next to the trailing number. Only once a day's count exceeds 40 does every bar get scaled down together (the busiest day becomes exactly 40 characters, every other day shrinks by the same factor), so one very busy day can't blow out terminal width while relative proportions between days stay meaningful. No dependency — just repeated `█` characters, same zero-dependency philosophy as everything else in this CLI.

**Date-range filtering** — see [Date-range filtering](#date-range-filtering---since--until) below.

### `friction-log edit <id> [--note <note>] [--tag <tag>]`

Updates an existing entry in place, by the short id shown in `list`. Pass `--note`, `--tag`, or both; anything you omit is left unchanged.

```bash
$ friction-log edit a1b2c3d4 --tag worked-well
✓ Updated entry a1b2c3d4: [worked-well] OAuth token refresh docs were split across three pages
```

An unknown id fails clearly instead of silently no-op'ing:

```bash
$ friction-log edit doesnotexist --tag friction
Error: No entry with id "doesnotexist" found. Run "friction-log list" to see valid ids.
```

### `friction-log remove <id>`

Deletes an entry by id. Same not-found error as `edit` if the id doesn't exist.

```bash
$ friction-log remove a1b2c3d4
✓ Removed entry a1b2c3d4: [worked-well] OAuth token refresh docs were split across three pages
```

### `friction-log merge <otherFile> --into <targetFile>`

Combines entries from another `.friction-log.json`-shaped file into a target log file — for a team logging friction across multiple machines or branches and wanting one combined report at the end. Entries are de-duplicated by id (an entry present in both files is kept once, not doubled), and the result is re-sorted chronologically.

```bash
$ friction-log merge ../teammate-laptop/.friction-log.json --into .friction-log.json
✓ Merged /home/you/teammate-laptop/.friction-log.json into /home/you/my-hackathon-project/.friction-log.json: +4 new, 1 duplicate(s) skipped, 11 total.
```

Both paths can be relative or absolute; `<otherFile>` is only read, `<targetFile>` is the one that gets updated. `<targetFile>` must already exist (run `init` there first if it doesn't).

### `friction-log sync <url> [--push|--pull]`

Exchanges entries with a remote over HTTP, using the exact same id-based dedup logic as `merge` (`mergeEntries`, shared by both — one implementation, not two copies to keep in sync). Exactly one of `--push` or `--pull` must be given.

```bash
$ friction-log sync https://team.example.com/friction-log --push
✓ Pushed to https://team.example.com/friction-log: +3 new, 5 duplicate(s) skipped, 8 total on remote.

$ friction-log sync https://team.example.com/friction-log --pull
✓ Pulled from https://team.example.com/friction-log: +2 new, 6 duplicate(s) skipped, 8 total locally.
```

**The contract** (deliberately tiny — plain JSON over HTTP, nothing to install on the remote beyond something that speaks this shape):

| Method | Request body | Response body |
|---|---|---|
| `GET <url>` | — | `200` with `{ "entries": LogEntry[] }` — the remote's full current entry list |
| `POST <url>` | `{ "entries": LogEntry[] }` — the pusher's full local entry list | `200` with `{ "added": number, "duplicates": number, "total": number }` — what happened on the *remote's* side after merging the pushed entries in |

- `--pull` does a `GET`, merges the remote's entries into the local log via `mergeEntries`, and reports the **local** added/duplicates/total.
- `--push` does a `POST` of the full local log and reports back whatever added/duplicates/total the remote says happened on its side.

Because both directions dedup by entry `id`, running `sync` repeatedly (a cron job, a pre-submission ritual, a flaky connection retried) never doubles up entries — a second identical push or pull reports `+0 new` and leaves everything else unchanged. `sync` requires a log to already exist (`friction-log init` first), same as `list`/`export`/`stats`/`serve`/`watch`; an unreachable URL, a non-2xx response, or a response that doesn't match the JSON shape above all fail clearly instead of hanging or crashing with a raw stack trace.

No real server ships with this CLI — the contract above is everything a teammate (or this project's own test suite, which spins up a throwaway `node:http` listener as a stand-in) needs to implement to be a valid sync target.

### `friction-log template add <name> "<text with {placeholders}>" [--tag <tag>]`

Saves a reusable note template under `<name>`, with any number of `{placeholder}` tokens (a placeholder name is letters/digits/underscore). Re-running `template add` with a name that already exists **replaces** it rather than creating a duplicate. `--tag` is optional — a template can carry its own tag, applied by `template use` whenever that command's own `--tag` is omitted.

```bash
$ friction-log template add flaky-endpoint "{endpoint} returned {code} with no explanation" --tag friction
✓ Saved template "flaky-endpoint" (tag: friction): {endpoint} returned {code} with no explanation
```

### `friction-log template use <name> [--set key=value ...] [--tag <tag>]`

Fills in a saved template's placeholders and logs the result exactly like a normal `add` — same id generation, same git-aware tagging, same auto-tag fallback if neither the template nor `--tag` supplies a tag. Pass one `--set key=value` per placeholder; a placeholder with no matching `--set` fails clearly (listing every missing key at once) rather than silently saving a literal `{key}` in the note.

```bash
$ friction-log template use flaky-endpoint --set endpoint=/v1/token --set code=500
✓ Logged [friction] /v1/token returned 500 with no explanation

$ friction-log template use flaky-endpoint --set endpoint=/v1/refresh --set code=502 --tag worked-well
✓ Logged [worked-well] /v1/refresh returned 502 with no explanation
```

**Tag resolution order**: an explicit `--tag` on `use` always wins; otherwise the template's own saved tag is used; otherwise it falls through to `add`'s normal chain (a configured `defaultTag`, then the auto-tag heuristic, then `"note"`) — a template with no tag of its own behaves exactly like a plain untagged `add` once its placeholders are filled in.

### `friction-log template list`

Lists every saved template with its tag (if any) and raw `{placeholder}` text.

```bash
$ friction-log template list
flaky-endpoint [friction]: {endpoint} returned {code} with no explanation
```

```bash
$ friction-log template list
No templates saved yet.
```

Templates are stored per-directory in their own `.friction-log-templates.json` file — separate from `.friction-log.json` for the same reason `.friction-logrc.json` is separate: a template is a reusable shape for *future* entries, not itself a logged entry, and shouldn't be touched by `init --force` clearing the log.

### `friction-log serve [--port <port>]`

Starts a minimal, dependency-free local HTTP server (Node's built-in `http` module — no Express, no framework, nothing else to `npm install`) that serves a single styled HTML page listing every entry in the current directory's `.friction-log.json`. The log file is **re-read from disk on every request** — no caching — so `friction-log add "..."` in one terminal shows up the moment you reload the page in the other, with no server restart. Defaults to port `4848`; pass `--port 0` to let the OS assign a free ephemeral port (useful for scripting/tests).

```bash
$ friction-log serve
✓ Friction log server running at http://localhost:4848/
Press Ctrl-C to stop.
```

Visiting that URL renders a page with every entry (newest first), each showing its tag, timestamp, and note text. A `<select>` dropdown lets you filter by tag — it submits a plain GET form to `/?tag=friction`, so the filtering is entirely server-rendered (no client-side JavaScript required at all, though the dropdown auto-submits on change for convenience):

```bash
$ curl -s "http://localhost:4848/?tag=friction" | grep -A1 class=\"note\"
<p class="note">Alexa+ skill manifest schema errors gave no line numbers</p>
<p class="note">OAuth token refresh docs were split across three pages</p>
```

Stop it the same way as any other long-running CLI server — **Ctrl-C**. The process shuts the server down and exits cleanly (`SIGINT` is handled explicitly rather than left to Node's default).

An invalid `--port` (non-integer, negative, or above 65535) fails clearly instead of trying to bind a bogus port. `serve` requires a log to already exist (`friction-log init` first), same as `list`/`export`/`stats`.

### `friction-log watch`

An interactive, prompt-log-prompt REPL for rapid-fire logging: type a line, press Enter, it's logged immediately — then it prompts again, with no need to re-invoke `friction-log add "..." --tag ...` (flags and all) for every single thought as it happens.

```bash
$ friction-log watch
friction-log watch — one line per note, Enter to log it.
End a line with "#tagname" to tag it, e.g. "Docs 404 on first click #friction".
Blank line, "exit", or "quit" to stop.

> Docs page 404'd on the first click #friction
✓ Logged [friction] Docs page 404'd on the first click
> Ring OAuth sandbox credentials worked first try #worked-well
✓ Logged [worked-well] Ring OAuth sandbox credentials worked first try
> exit

Stopped. Run "friction-log list" to see everything you logged.
```

**Inline tag syntax**: end a line with a trailing `#tagname` (a `#` immediately followed by letters/digits/`-`/`_`, at the very end of the line) to tag that entry without ever touching a `--tag` flag. It's stripped from the saved note text. With no trailing `#tag`, `add`'s normal default chain applies (a configured `defaultTag`, then the auto-tag heuristic, then `"note"`).

**Auto-tag confirmation**: unlike a non-interactive `add` (which applies the heuristic's suggestion automatically), `watch` stops and asks first whenever a line has no inline `#tag` and the heuristic finds a keyword match — press **Enter** to accept the suggestion, or type a different tag and press Enter to use that instead:

```bash
> The build broke halfway through the demo
Suggested tag: friction (Enter to accept, or type a different tag)
>
✓ Logged [friction] The build broke halfway through the demo
```

No keyword match at all (or an inline `#tag`, which always short-circuits the suggestion) skips the confirmation step entirely and logs immediately, exactly as before this feature existed. See [Auto-tag suggestion](#auto-tag-suggestion) below for the exact keyword lists.

A **blank line**, or typing **`exit`**/**`quit`** (either case), ends the loop cleanly — nothing is logged for that final line. `watch` requires a log to already exist first (`friction-log init`).

Since it's built on Node's `readline`, it works the same whether stdin is a real terminal or a pipe — so it's also scriptable:

```bash
$ printf 'First rapid note\nSecond note #feature-request\n\n' | friction-log watch
```

### `friction-log export [--out <file>] [--title <title>] [--format json|md|txt] [--since <date>] [--until <date>]`

Renders the log as Markdown (default), plain text, or raw JSON, either to stdout or to a file. This is the command you run right before writing your hackathon submission's own `FRICTION_LOG.md` — or, with `--format json`, before feeding your friction log into some other script or CI check.

**Date-range filtering** — see [Date-range filtering](#date-range-filtering---since--until) below.

```bash
$ friction-log export --out FRICTION_LOG.md --title "Team Rocket — Friction Log"
✓ Exported friction log to FRICTION_LOG.md
```

`--format json` exports the raw structured entries as an array of objects — nothing summarized or reshaped, so it round-trips cleanly with `merge` and is easy to pipe into `jq` or a script:

```bash
$ friction-log export --format json
[
  {
    "id": "a1b2c3d4",
    "timestamp": "2026-09-02T09:14:03.112Z",
    "note": "OAuth token refresh docs were split across three pages",
    "tag": "friction",
    "gitBranch": "main",
    "gitCommit": "4dc9d98"
  }
]
```

`--format txt` renders the same grouped sections as the Markdown export, but as plain text (no `#` headings, no `_..._` emphasis) — for pasting somewhere that doesn't render Markdown:

```
Friction Log
============

FRICTION ENCOUNTERED
--------------------
1. OAuth token refresh docs were split across three pages (2026-09-02 09:14 UTC)
```

Sample Markdown output (the default, `--format md`):

```markdown
# Team Rocket — Friction Log

_Generated by friction-log-toolkit on 2026-09-02 12:28:15 UTC. 5 entries logged since 2026-09-02 09:14:02 UTC._

## What worked well

- Ring OAuth sandbox credentials worked first try, no waiting on approval _(2026-09-02 12:28:15 UTC)_

## Friction encountered

1. Alexa+ skill manifest schema errors gave no line numbers, just a generic 400 _(2026-09-02 12:28:15 UTC)_
2. Docs for Bee webhook signing are split across two pages _(2026-09-02 12:28:15 UTC)_

## Feature requests

- Wish the Fire TV emulator had a --reset flag _(2026-09-02 12:28:15 UTC)_

## Other notes

- **[note]** Random thought: should track time-of-day too _(2026-09-02 12:28:15 UTC)_
```

### Date-range filtering (`--since`/`--until`)

`list`, `export`, and `stats` all accept `--since <date>` and/or `--until <date>`, narrowing to entries in that range **before** any tag filtering, grouping, or aggregation runs. Either flag can be used alone. Both accept anything JavaScript's `Date.parse` can read — a bare `"2026-09-01"`, a full ISO-8601 timestamp like `"2026-09-01T14:00:00Z"`, or anything else `Date.parse` understands.

```bash
$ friction-log list --since 2026-09-02
[friction] a1b2c3d4  2026-09-02T09:14:03.112Z  OAuth token refresh docs were split across three pages
[worked-well] f9e8d7c6  2026-09-02T12:28:15.045Z  Ring OAuth sandbox credentials worked first try

$ friction-log stats --since 2026-09-01 --until 2026-09-01
Friction Log Stats
-------------------
Total entries: 3
By tag:
  friction: 2
  worked-well: 1
Date range: 2026-09-01 09:02 UTC -> 2026-09-01 18:44 UTC
Busiest day: 2026-09-01 (3 entries)

$ friction-log export --format json --since 2026-09-02 --out today.json
✓ Exported friction log to today.json
```

**A bare date-only `--until` means the end of that day, not its first instant** — `--until 2026-09-01` includes everything logged through `2026-09-01T23:59:59.999Z`, not just entries at exactly midnight. This is specifically so `--since 2026-09-02 --until 2026-09-02` reads naturally as "just today's session" on a multi-day hackathon, rather than an empty range. `--since` needs no equivalent adjustment: a bare date there already means "from the start of that day onward", which is what you want.

An unparseable date fails clearly rather than silently matching (or excluding) everything:

```bash
$ friction-log list --since "not-a-real-date"
Error: Could not parse --since "not-a-real-date" as a date.
```

### Auto-tag suggestion

When `add` (or a line in `watch`) has no explicit `--tag` **and** no configured `defaultTag`, a small keyword heuristic (`src/autotag.ts`, no NLP, no dependency) suggests a tag by checking the note's text (case-insensitive) against three fixed keyword lists, in this order — the first list with a match wins:

| Suggested tag | Keywords checked |
|---|---|
| `friction` | bug, broke, broken, breaks, error, errors, errored, crash, crashed, crashes, fail, failed, failing, confusing, confused, stuck |
| `worked-well` | worked, works, nice, clean, smooth, smoothly, great, easy, painless |
| `feature-request` | should, would be nice, wish, wished, could use, want |

A single-word keyword matches on a `\b` word boundary against the note, lowercased (`"fail"` matches `"the build failed"` via `"failed"` containing `"fail"` followed by more word characters — word-boundary matching finds the keyword as a substring of a longer word too, it's not whole-word-only); a multi-word phrase (`"would be nice"`, `"could use"`) matches as a plain substring. This is intentionally simple — a keyword list, not a tokenizer or classifier. No match at all falls through to whatever the normal default would have been anyway (a configured `defaultTag`, else `"note"`).

**`add` applies the suggestion automatically** and says so in its confirmation line, so it's never a silent surprise:

```bash
$ friction-log add "The build broke halfway through the demo"
✓ Logged [friction] The build broke halfway through the demo (auto-tagged "friction" based on the note text — override any time with --tag)
```

**`watch` asks for confirmation instead** — see [the `watch` section](#friction-log-watch) above. An explicit `--tag` (on `add`) or an inline `#tag` (in `watch`) always short-circuits the heuristic entirely; it's only ever consulted when nothing else already decided the tag.

### Errors

Running `add`, `list`, or `export` before `init` gives a clear, actionable message instead of a stack trace:

```bash
$ friction-log add "too early"
Error: No friction log found in /home/you/my-hackathon-project (missing .friction-log.json).
Run "friction-log init" first to create one.
```

An unknown command prints usage help and exits non-zero:

```bash
$ friction-log frobnicate
Error: Unknown command "frobnicate".

friction-log — capture friction points in the moment, export them as a Markdown report.
...
```

## Config file: `.friction-logrc.json`

An optional file, read from the current directory, for team-wide defaults. CLI flags always win when both are given.

```json
{
  "defaultTag": "friction",
  "export": {
    "title": "Team Rocket — Friction Log",
    "out": "FRICTION_LOG.md",
    "format": "md"
  }
}
```

- `defaultTag` — used by `add` whenever `--tag` is omitted, instead of the hardcoded `"note"`.
- `export.title` / `export.out` / `export.format` — used by `export` whenever the matching flag (`--title` / `--out` / `--format`) is omitted.

**Why a separate file instead of a block inside `.friction-log.json`**: `.friction-log.json` is per-machine working state — it fills up with personal in-the-moment notes and is usually gitignored — while an rc file holding team-wide defaults (a shared default tag, a standard export title everyone should use) is exactly the kind of thing you *do* want checked into the repo. Keeping them separate also means a config choice never gets clobbered by `init --force`, and `readConfig` only has to run for `add`/`export`, not for every command that touches the log.

It's entirely optional — every command works fine with no `.friction-logrc.json` present at all.

## Project layout

```
friction-log-toolkit/
  package.json        type: module, bin: friction-log -> dist/cli.js
  tsconfig.json        ES2022 / NodeNext / strict
  src/
    types.ts            LogEntry, LogFile shapes (id, gitBranch/gitCommit are optional/additive)
    store.ts             read/write .friction-log.json (or any log-shaped file, for merge), id backfill for older files
    config.ts             reads the optional .friction-logrc.json
    git.ts                 best-effort current branch + short commit hash, no-ops outside a git repo
    autotag.ts              the auto-tag keyword heuristic (suggestTag), shared by add and watch
    templates.ts             reusable {placeholder} note templates, own .friction-log-templates.json file
    chart.ts                 the "stats" ASCII bar chart renderer, no dependency
    sync.ts                   push/pull against a remote over the sync HTTP contract, reuses mergeEntries
    commands.ts             init/add/list/search/export/stats/edit/remove/merge/useTemplate logic (+ mergeEntries,
                             shared by merge and sync) + --since/--until filtering, decoupled from argv parsing
    exporter.ts              Markdown/plain-text/JSON report generation from a LogFile
    server.ts                 the "serve" HTTP server: dependency-free node:http, re-reads the log file per request
    watch.ts                   the "watch" REPL: pure handleWatchLine/resolveWatchTag (testable directly) + the
                                readline-driven loop (with the auto-tag confirmation step) around them
    cli.ts                       argv parsing + dispatch (the bin entry point, has the shebang)
  test/
    smoke.test.ts             real end-to-end test, subprocess + temp dirs, no mocks
  README.md
  FRICTION_LOG.md              this project's own friction log about building it
```

The `commands.ts` functions take a working directory explicitly and are fully decoupled from `process.argv` and process I/O (aside from the file writes they're meant to do), so they're testable directly, and `cli.ts` stays a thin, easily-audited translation layer between flags and those functions.

## Testing

```bash
npm test
```

This runs `npm run build` followed by `test/smoke.test.ts` (via `tsx`, using Node's built-in `assert/strict`). The test is a genuine end-to-end test: it invokes the **compiled** CLI (`node dist/cli.js ...`) as a real child process against a fresh temporary directory (`node:fs.mkdtempSync` + `node:os.tmpdir()`), created and cleaned up per scenario — no mocking of the filesystem or of `commands.ts`. As of this round, that's **137 passing checks**.

It covers:

- **Golden path** — `init` → `add` five entries across all four tag categories → `list` (all, and filtered by tag) → `export --out` → the resulting Markdown has the right headings with the right entries filed under each one, in the right order.
- **`add`/`list` before `init`** — both fail with a non-zero exit and a clear message; no `.friction-log.json` is created by a failed `add`.
- **`init` twice without `--force`** — the second call fails and leaves the original log byte-for-byte unchanged; `init --force` then succeeds.
- **Exporting an empty log** — produces valid Markdown with all four section headings present and a friendly "no entries yet" placeholder under each, rather than throwing.
- **`stats`** — correct total, per-tag breakdown, date range, and busiest day, both with entries and on an empty log.
- **Config-file defaults** — `.friction-logrc.json`'s `defaultTag` and `export.title`/`export.format` are honored when the matching flag is omitted, and a CLI flag always overrides the config value when both are given.
- **Multiple export formats** — `--format json` round-trips the raw entry objects (ids, tags, git fields included); `--format txt` renders the same grouped sections with no Markdown syntax; an unrecognized `--format` fails clearly; the no-flag default is still Markdown.
- **Git-aware tagging** — inside a real temp git repo (created with `git init -b <branch>` + an actual commit as part of the test setup), `add` records the true branch name and short commit hash, and the CLI's confirmation line surfaces them; in a second, plain (non-git) temp directory, `add` still succeeds and simply omits `gitBranch`/`gitCommit` — a genuine no-op, not a caught error.
- **`edit`/`remove`** — editing a note/tag by id persists and preserves the id; editing or removing an unknown id fails clearly; removing an entry actually deletes it (and removing it again then fails).
- **`merge`** — merging two logs that share one entry id and each have unique entries de-duplicates the shared one instead of doubling it up, reports accurate added/duplicate/total counts, and fails clearly when the source file doesn't exist.
- **`search`** — finds a known entry by a case-insensitive substring, excludes non-matching entries, and `--tag` narrows results to (and excludes a textual match outside of) one tag.
- **`--since`/`--until`** on `list`/`export`/`stats` — entries are backdated/future-dated directly in the log file to give the filter real boundaries to respect (rather than a mocked clock), confirming in-range entries are kept, out-of-range entries on both sides are excluded, filtering happens before grouping in `export`, and an unparseable date fails clearly instead of silently matching everything.
- **`watch`** — both the pure `handleWatchLine` function directly (plain lines default to `"note"`, a trailing `#tag` is parsed off and applied, a blank line and `"exit"`/`"quit"` end the loop without logging) *and* the real `friction-log watch` subprocess end-to-end, piping input at its stdin and checking both the console output and the persisted entries.
- **`serve`** — spawned as a real child process on an ephemeral port (`--port 0`, port read back from its printed URL), then hit with real `fetch()` calls: the response is 200 with HTML containing known entries' text, the `?tag=` filter narrows what's rendered, and a `friction-log add` run *while the server is still up* shows up on the next request with no restart — proving there's no caching.
- **Auto-tag suggestion** — `suggestTag` unit-tested directly for representative friction/worked-well/feature-request note text and text matching nothing; a non-interactive `add` with no `--tag` on the same kinds of text confirms the tag is actually applied, persisted, *and* announced in the CLI's output (never silently), that an explicit `--tag` always overrides the heuristic, and that plain text with no keyword match still carries no auto-tag notice; `watch` is tested piping input where a suggested tag is accepted with a blank confirmation line, overridden with a typed tag, and skipped entirely for text with no suggestion — plus direct unit tests of `handleWatchLine`'s `needs-tag` result and `resolveWatchTag`.
- **`stats` ASCII bar chart** — six entries backdated (directly in the log file, real boundaries) across three days with counts 1/3/2, confirming the chart renders one line per day with a raw block-character count matching each day's total exactly, and that bar lengths are proportional (the 3-entry day's bar is longest) — plus that an empty log prints no "Daily activity" section at all.
- **Entry templates** — `template add`/`list`/`use` end to end: a template with a `{placeholder}` fills in correctly and logs with the template's own tag; `--tag` on `use` overrides that tag; a missing `--set` for a required placeholder and an unknown template name both fail clearly; re-adding an existing template name replaces it instead of duplicating; a template with no tag at all falls through to `add`'s normal default chain.
- **`sync` push/pull** — a genuine round-trip against a real `node:http` server standing in for "the remote" (spun up in-process on an ephemeral port, reusing the exact same `mergeEntries` the real CLI's `merge` uses for its own dedup): pushing from one directory, pulling into a fresh second directory, confirming both directions report accurate added/duplicate/total counts, that re-running either is fully idempotent (`+0 new` the second time), and that entries genuinely round-trip both ways through the remote (B's new entry reaches A via a second pull) — plus that `sync` with neither or both of `--push`/`--pull`, and a genuinely unreachable URL, all fail clearly instead of hanging.

## Judging-criteria alignment

- **Tech Implementation** — A real, typed, strict-mode TypeScript CLI with zero runtime dependencies beyond Node itself (the local web dashboard and `sync`'s remote contract are Node's built-in `http`/`fetch`, not Express or axios; the REPL is Node's built-in `readline`), a clean layered architecture (`store`/`config`/`git`/`autotag`/`templates`/`chart` → `commands`/`server`/`watch`/`sync` → `cli`), and a genuine subprocess-level end-to-end test suite (**137 checks**) covering the golden path, edge cases, and every feature added across all four rounds — including a real git repo spun up in a temp directory for git-aware tagging, a real HTTP server hit with real `fetch()` calls on an ephemeral port for `serve`, a *second* real HTTP server standing in for a sync remote (reusing the exact same dedup logic `merge` uses, so both are provably safe to run repeatedly), and both a direct unit test of the exact functions `watch` uses and a full piped-stdin subprocess run for `watch` (including its interactive auto-tag confirmation step). `npx tsc --noEmit` passes with zero errors.
- **Design** — The whole point of the tool is near-zero friction to use: one short command to log a thought the moment it happens, with a sensible default tag — now guessed for you from the note's own wording when you don't have one in mind — so you never have to stop and think about taxonomy mid-flow. `watch` pushes that further — no flags at all once it's running, just typing and Enter, with an inline `#tag` convention for when a tag matters, and a confirmable (not silently-applied) suggestion the rest of the time. Errors are actionable, not stack traces. The exported Markdown is a drop-in match for the `FRICTION_LOG.md` structure judges are already reading elsewhere in this repo, `serve` gives a shareable, always-current dashboard view with zero setup, and templates turn a friction point you keep re-describing (a flaky endpoint, a recurring doc gap) into one command instead of retyping the shape of it every time.
- **Potential Impact** — Every team in this hackathon (and Amazon's own developer-experience team, reading the resulting friction logs as structured feedback) benefits from more accurate, more complete friction logs, captured as things actually happen instead of reconstructed from memory at 11pm before the deadline. `sync` extends that from a single machine to an actual team — everyone's `watch` sessions converging into one shared friction log without anyone hand-merging JSON files. It's equally usable on any track — Fire TV, Alexa+, Bee, Ring — since it has no dependency on any Amazon SDK at all.
- **Quality of Idea** — This submission satisfies the Open Source mini-challenge's required tech (**"a new public repository"**) directly and completely, on its own, regardless of what primary track a team pairs it with. It's also self-referential in a way that's memorable: the tool that helps you write your friction log has its own friction log (see `FRICTION_LOG.md`), written using the exact section structure the tool itself produces.

## Scope boundaries / next steps for real open-source adoption

This is a hackathon-scoped submission. Genuine next steps toward real adoption, intentionally left out of scope here:

- Publish to npm as a real package so `npm install -g friction-log-toolkit` works without cloning the repo.
- Add a `LICENSE` file (MIT, matching the rest of this monorepo) at the package root once it's split into its own repository.
- Add a GitHub Actions CI workflow running `npm ci && npm run build && npm test` on push/PR.
- Shell tab-completion (bash/zsh) for tag names and entry ids.
- `stats --json` for feeding the summary into a script or CI check the same way `export --format json` does today.
- `serve`'s dashboard is read-only today (viewing + filtering only) — a real next step would be letting it accept new entries or edits from the browser too, not just the CLI.
- `search` is a plain substring match by design (see the README's note on why); a real fuzzy/ranked search would be a bigger, separate feature.
- `sync` has no authentication story at all — the contract is plain unauthenticated JSON over HTTP, fine for a hackathon team's own trusted endpoint but not something to point at anything public; a real next step would be an `Authorization` header (a token from an env var or `.friction-logrc.json`) the client sends and the remote contract documents checking.
- The auto-tag heuristic's keyword lists are hardcoded in `autotag.ts`; letting a team extend or override them (e.g. via `.friction-logrc.json`) instead of editing source would make it useful for vocabulary specific to a given SDK or platform.
- Templates are per-directory only, same as the log itself — sharing a team's template set the way `sync` shares entries (or just checking `.friction-log-templates.json` into the repo, since it's already git-friendly plain JSON) is a natural next step, just not automated yet.

**Backward compatibility note**: `id`, `gitBranch`, and `gitCommit` are additive, optional fields on `LogEntry` — an existing `.friction-log.json` written by v1 (no `id`s at all) still loads and works with every command. The first time such a file is read, missing ids are backfilled and the file is rewritten once to persist them (so `edit`/`remove`/`merge` have something stable to reference); no other field is touched, and nothing is required to be present that wasn't already.
