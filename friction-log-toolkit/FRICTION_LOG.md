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
