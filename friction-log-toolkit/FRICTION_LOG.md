# Friction Log — building friction-log-toolkit

Meta, but genuine: notes from actually building the tool, written by hand in the same shape it exports.

## What worked well

- Deciding on three well-known tags (`worked-well`, `friction`, `feature-request`) plus a default `note` catch-all early made both `commands.ts` and `exporter.ts` trivial — the exporter is just four `Array.filter` calls, no state machine or config needed.
- Keeping `commands.ts` completely decoupled from `process.argv` (every function takes an explicit `dir` and a plain options object) paid off immediately: the smoke test could have called these functions directly, and even testing via subprocess, the separation kept `cli.ts` small enough to read top to bottom in one pass.
- A hand-rolled argv parser (~15 lines: split on `--flag value` pairs, everything else positional) was genuinely less work than researching and pinning a CLI framework dependency, and it's easy to reason about exactly what it does — no framework magic to look up when something behaves oddly.
- Node's built-in `assert/strict` + `execFileSync` was enough to write a real subprocess-level test with zero test-framework dependencies, which matters for a tool whose whole pitch is a minimal footprint.

## Friction encountered

1. First pass at `execFileSync` error handling assumed a non-zero exit would throw an error object with a `.status` that's always a number, but on some failure paths Node sets `status: null` (e.g. if the process were killed by a signal) — had to widen the type to `number | null | undefined` and coalesce, or TypeScript's `strict` mode flagged the assumption.
2. Timestamp formatting had a small tug-of-war: raw ISO-8601 (`2026-09-02T12:28:15.045Z`) is what you want in the JSON store (sortable, unambiguous), but it's noisy in the exported Markdown next to a note. Landed on stripping milliseconds and swapping `T`/trailing `Z` for a plain `YYYY-MM-DD HH:MM UTC` in `exporter.ts` only, keeping the stored format untouched — deciding *where* in the pipeline to do that formatting (store vs. exporter vs. CLI print) took more thought than the regex itself.
3. Testing a CLI as a subprocess vs. testing `commands.ts` directly is a real tradeoff, not a solved question: subprocess tests catch real bugs in `cli.ts`'s flag parsing and exit codes (which is exactly where a hand-rolled parser is most likely to have a bug) but are slower and their failure output is a step removed from the source line at fault. Ended up testing through the subprocess for the "does the whole CLI work" confidence, accepting the slightly worse debugging loop as the price of testing what actually ships.
4. Easy to accidentally let a failed `add` (called before `init`) still partially create a log file if the store-read and store-write weren't cleanly separated — worth an explicit test case (`add before init does not create a log file`) rather than just checking the exit code, since a silent empty/corrupt `.friction-log.json` would be a worse failure mode than a clean error.

## Feature requests

- A `--since <date>` filter on `list`/`export`, for a multi-day hackathon where you only want the friction log for "today's" session.
- Shell tab-completion (bash/zsh) for tag names, generated from whatever tags already exist in the current log — small thing, but it's exactly the kind of friction this tool exists to reduce for its own users.
- An optional `--interactive` mode for `add` that prompts for the tag from a short list instead of requiring `--tag` to be remembered and typed correctly every time.

---

## Round 2: stats, config, git-aware tagging, multi-format export, merge, edit/remove

More friction notes, from adding the six features above on top of v1.

### What worked well

- Introducing per-entry `id` as an *optional* field on `LogEntry` and backfilling it lazily inside `readLogFile` (generate + persist the first time an old file without ids is read) meant `edit`/`remove`/`merge` got a stable key to work with without a version bump, a migration command, or breaking a single existing `.friction-log.json` on disk. Verified this for real (not just by reasoning about it): hand-wrote a v1-shaped JSON file with no `id` field, ran `list`, and watched the file get rewritten with a backfilled id in place — everything downstream (`stats`, `export --format json`) worked on the very next command with no extra step from the user.
- Refactoring `store.ts` to route both the existing `dir`-based `readLog`/`writeLog` and a new arbitrary-path `readLogFile`/`writeLogFile` through the same parse/normalize logic (instead of writing merge-specific file I/O) meant `merge` got id-backfilling "for free" on both the source and target file, and there was only one place that could get the JSON-shape validation wrong.
- Keeping `git.ts` to two `execFileSync` calls wrapped in a single `try/catch` that returns `undefined` on *any* failure — wrong binary, not a repo, no commits yet — was a case where resisting the urge to distinguish and report each failure mode separately was the right call: the feature's whole contract is "best-effort and silent," so a more granular implementation would just be more surface area for a purely-informational feature to break the main flow.

### Friction encountered

1. Testing "git-aware tagging" reliably was the trickiest part of this round, because it requires the test itself to fabricate a real, valid git repository rather than mocking `execFileSync`. Two subtleties bit on the first pass: (a) a bare `git init` picks up whatever `init.defaultBranch` happens to be configured globally on the machine running the test, so asserting the captured branch name against a hardcoded string like `"main"` would be flaky across environments — fixed by using `git init -b <explicit-test-branch-name>` in the test fixture itself, so the expected value is never ambient state; (b) `git rev-parse --abbrev-ref HEAD`/`--short HEAD` both fail on a freshly-`init`'d repo with zero commits (no HEAD to resolve yet), so the test has to actually stage and commit a file before asserting anything — and that same "no commits yet" case is exactly one of the paths the no-op behavior needs to cover gracefully in the *first place*, so it was worth a second dedicated test in a repo-less temp directory to keep the two failure modes (no repo at all vs. repo with no commits) from being conflated into one assertion.
2. Deciding where a "config file" belongs took longer than writing `config.ts` itself. The instinct was to reuse `.friction-log.json` since it already has a well-tested read/write path — but that file is per-machine, fills up with personal notes, and gets clobbered by `init --force`, none of which are true of the kind of thing you'd want a config file for (a team's shared default tag, a standard export title). Landed on a separate `.friction-logrc.json`, matching the `.eslintrc`/`.prettierrc` convention, specifically so it never has to survive being reset alongside the log data and so `add`/`export` are the only two commands that pay the cost of reading it.
3. The merge/dedup logic looked trivial ("skip ids already in the target") until writing the smoke test forced a concrete scenario: two logs that started identical (same shared entry, same id) and then diverged independently on two "machines." Simulating that in a subprocess-only test meant writing the *target*'s initial `.friction-log.json` by copying the *source*'s file byte-for-byte (via `fs.readFileSync`/`writeFileSync` in the test, not through the CLI) before running any further `add`s on either side — otherwise there's no way to get two independently-generated logs to legitimately share an entry id, since ids are randomly generated per `add`. That test setup detail was more work than the three-line `Set`-based de-dup in `commands.ts` that it was meant to exercise.
4. Sorting the merged target's entries by `timestamp` after combining (rather than just appending the source's entries at the end) was an easy thing to skip and get away with in a small manual test, but it matters for `export`'s numbered "Friction encountered" list to stay meaningfully ordered once two people's logs are combined — worth calling out as a case where "the test passed" and "the feature behaves sensibly for its actual use case" were briefly two different bars.
