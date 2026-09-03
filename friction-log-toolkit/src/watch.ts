import { createInterface } from "node:readline";
import { add } from "./commands.js";
import type { LogEntry } from "./types.js";

/**
 * `friction-log watch` is an interactive REPL loop for rapid-fire logging:
 * prompt for a line, log it, prompt again — without re-invoking `friction-log
 * add "..." --tag ...` (flags and all) for every single thought.
 *
 * Inline tag syntax: a trailing "#tagname" at the end of a line sets that
 * entry's tag and is stripped from the note text before it's saved, e.g.:
 *
 *   > Docs page 404'd on first click #friction
 *   ✓ Logged [friction] Docs page 404'd on first click
 *
 * With no inline tag, the normal `add` default applies (a configured
 * `defaultTag`, else "note") — exactly like calling `add` with no `--tag`.
 * A blank line (nothing typed, or a line that's *only* a bare "#tag" with no
 * note text) or typing "exit"/"quit" (case-insensitive) ends the loop
 * cleanly, without logging anything for that final line.
 *
 * This module is split into a pure line-handler (`handleWatchLine`, easy to
 * unit test without a TTY) and the actual readline-driven loop
 * (`runWatch`), which is the thin, mostly-untestable-without-a-real-pipe
 * wrapper around it.
 */

const TRAILING_TAG_RE = /#([A-Za-z0-9_-]+)\s*$/;

export type WatchLineResult =
  | { kind: "exit" }
  | { kind: "empty" }
  | { kind: "logged"; entry: LogEntry };

/**
 * Parses and applies one line of `watch` input against the log at `dir`.
 * Pure with respect to readline/stdin — it only touches the filesystem (via
 * `add`) — so it's the piece both `runWatch` and tests call directly.
 */
export function handleWatchLine(dir: string, rawLine: string): WatchLineResult {
  const line = rawLine.trim();
  if (line.length === 0) return { kind: "empty" };
  if (/^(exit|quit)$/i.test(line)) return { kind: "exit" };

  let note = line;
  let tag: string | undefined;
  const match = line.match(TRAILING_TAG_RE);
  if (match) {
    tag = match[1];
    note = line.slice(0, match.index).trim();
  }

  if (note.length === 0) {
    // A bare "#tag" with nothing else typed — nothing meaningful to log.
    return { kind: "empty" };
  }

  const entry = add(dir, note, { tag });
  return { kind: "logged", entry };
}

export interface RunWatchOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Runs the interactive prompt-log-prompt loop against `dir` until a blank
 * line, "exit", "quit", or end-of-input (EOF on piped stdin, or Ctrl-D on a
 * real terminal). Resolves once the loop has ended.
 */
export function runWatch(dir: string, options: RunWatchOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, output, terminal: false });

  return new Promise((resolveWatch) => {
    output.write(
      "friction-log watch — one line per note, Enter to log it.\n" +
        'End a line with "#tagname" to tag it, e.g. "Docs 404 on first click #friction".\n' +
        'Blank line, "exit", or "quit" to stop.\n\n'
    );
    rl.setPrompt("> ");
    rl.prompt();

    rl.on("line", (line) => {
      let result: WatchLineResult;
      try {
        result = handleWatchLine(dir, line);
      } catch (err) {
        output.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        rl.prompt();
        return;
      }

      if (result.kind === "exit" || result.kind === "empty") {
        rl.close();
        return;
      }

      const gitSuffix = result.entry.gitBranch ? ` (${result.entry.gitBranch}@${result.entry.gitCommit})` : "";
      output.write(`✓ Logged [${result.entry.tag}] ${result.entry.note}${gitSuffix}\n`);
      rl.prompt();
    });

    rl.on("close", () => {
      output.write('\nStopped. Run "friction-log list" to see everything you logged.\n');
      resolveWatch();
    });
  });
}
