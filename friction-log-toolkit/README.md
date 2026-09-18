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

A quick summary: total entries, a breakdown per tag, the date range covered, and which single day had the most entries logged. Just a fast mid-hackathon check-in on how much you've captured so far.

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
```

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

**Inline tag syntax**: end a line with a trailing `#tagname` (a `#` immediately followed by letters/digits/`-`/`_`, at the very end of the line) to tag that entry without ever touching a `--tag` flag. It's stripped from the saved note text. With no trailing `#tag`, the line is logged with the normal `add` default (a configured `defaultTag`, else `"note"`) — exactly as if you'd run `add` with no `--tag` at all.

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
    commands.ts             init/add/list/search/export/stats/edit/remove/merge logic + --since/--until filtering, decoupled from argv parsing
    exporter.ts              Markdown/plain-text/JSON report generation from a LogFile
    server.ts                 the "serve" HTTP server: dependency-free node:http, re-reads the log file per request
    watch.ts                   the "watch" REPL: pure handleWatchLine (testable directly) + the readline-driven loop around it
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

This runs `npm run build` followed by `test/smoke.test.ts` (via `tsx`, using Node's built-in `assert/strict`). The test is a genuine end-to-end test: it invokes the **compiled** CLI (`node dist/cli.js ...`) as a real child process against a fresh temporary directory (`node:fs.mkdtempSync` + `node:os.tmpdir()`), created and cleaned up per scenario — no mocking of the filesystem or of `commands.ts`. As of this round, that's **85 passing checks**.

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

## Judging-criteria alignment

- **Tech Implementation** — A real, typed, strict-mode TypeScript CLI with zero runtime dependencies beyond Node itself (the local web dashboard is Node's built-in `http`, not Express; the REPL is Node's built-in `readline`), a clean layered architecture (`store`/`config`/`git` → `commands`/`server`/`watch` → `cli`), and a genuine subprocess-level end-to-end test suite (**85 checks**) covering the golden path, edge cases, and every feature added across both rounds — including a real git repo spun up in a temp directory for git-aware tagging, a real HTTP server hit with real `fetch()` calls on an ephemeral port for `serve`, and both a direct unit test of the exact function `watch` uses and a full piped-stdin subprocess run for `watch`. `npx tsc --noEmit` passes with zero errors.
- **Design** — The whole point of the tool is near-zero friction to use: one short command to log a thought the moment it happens, with a sensible default tag so you never have to stop and think about taxonomy mid-flow. `watch` pushes that further — no flags at all once it's running, just typing and Enter, with an inline `#tag` convention for when a tag matters. Errors are actionable, not stack traces. The exported Markdown is a drop-in match for the `FRICTION_LOG.md` structure judges are already reading elsewhere in this repo, and `serve` gives a shareable, always-current dashboard view with zero setup.
- **Potential Impact** — Every team in this hackathon (and Amazon's own developer-experience team, reading the resulting friction logs as structured feedback) benefits from more accurate, more complete friction logs, captured as things actually happen instead of reconstructed from memory at 11pm before the deadline. It's equally usable on any track — Fire TV, Alexa+, Bee, Ring — since it has no dependency on any Amazon SDK at all.
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

**Backward compatibility note**: `id`, `gitBranch`, and `gitCommit` are additive, optional fields on `LogEntry` — an existing `.friction-log.json` written by v1 (no `id`s at all) still loads and works with every command. The first time such a file is read, missing ids are backfilled and the file is rewritten once to persist them (so `edit`/`remove`/`merge` have something stable to reference); no other field is touched, and nothing is required to be present that wasn't already.
