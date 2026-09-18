import { createInterface, type Interface } from "node:readline";
import { add } from "./commands.js";
import { suggestTag } from "./autotag.js";
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
 * With no inline tag, `add`'s own auto-tag heuristic (`autotag.ts`) gets a
 * chance to suggest one from the note's keywords (e.g. "broke"/"error"
 * suggests "friction"). Unlike a non-interactive `add`, `watch` doesn't
 * silently apply that suggestion — it prompts for confirmation, so a
 * plain Enter accepts the suggested tag and typing a different word uses
 * that instead:
 *
 *   > The build broke halfway through
 *   Suggested tag: friction (Enter to accept, or type a different tag)
 *   >
 *   ✓ Logged [friction] The build broke halfway through
 *
 * With no inline tag *and* no suggestion, the normal `add` default applies
 * (a configured `defaultTag`, else "note") — exactly like calling `add`
 * with no `--tag`. A blank line (nothing typed, or a line that's *only* a
 * bare "#tag" with no note text) or typing "exit"/"quit" (case-insensitive)
 * ends the loop cleanly, without logging anything for that final line.
 *
 * This module is split into a pure line-handler (`handleWatchLine`, easy to
 * unit test without a TTY) plus `resolveWatchTag` (completes a `needs-tag`
 * result once the interactive confirmation answer is known) and the actual
 * readline-driven loop (`runWatch`), which is the thin, mostly-untestable-
 * without-a-real-pipe wrapper around them.
 */

const TRAILING_TAG_RE = /#([A-Za-z0-9_-]+)\s*$/;

export type WatchLineResult =
  | { kind: "exit" }
  | { kind: "empty" }
  | { kind: "logged"; entry: LogEntry }
  | { kind: "needs-tag"; note: string; suggestedTag: string };

/**
 * Parses and applies one line of `watch` input against the log at `dir`.
 * Pure with respect to readline/stdin — it only touches the filesystem (via
 * `add`) — so it's the piece both `runWatch` and tests call directly.
 *
 * When the line has no inline `#tag` and the auto-tag heuristic finds a
 * keyword match, this returns `needs-tag` *without* logging anything yet —
 * the caller (`runWatch`, or a test) is expected to ask for confirmation
 * and then call `resolveWatchTag`. Every other case (an inline tag, no
 * suggestion at all, exit/empty) resolves and logs immediately, same as
 * before this feature existed.
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

  if (tag === undefined) {
    const suggested = suggestTag(note);
    if (suggested) {
      return { kind: "needs-tag", note, suggestedTag: suggested };
    }
  }

  const { entry } = add(dir, note, { tag });
  return { kind: "logged", entry };
}

/**
 * Completes a `needs-tag` result once the interactive confirmation answer
 * is known: a blank answer accepts `suggestedTag`, anything else is used
 * as the tag verbatim.
 */
export function resolveWatchTag(dir: string, note: string, suggestedTag: string, answer: string): LogEntry {
  const trimmedAnswer = answer.trim();
  const tag = trimmedAnswer.length === 0 ? suggestedTag : trimmedAnswer;
  const { entry } = add(dir, note, { tag });
  return entry;
}

export interface RunWatchOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * A small async queue over `rl`'s `"line"` events, so lines can be consumed
 * one at a time via `await next()` regardless of *when* they actually
 * arrive relative to when we ask for them.
 *
 * This matters specifically because piped (non-TTY) input typically arrives
 * as one bulk chunk: `readline` then emits every buffered line's `"line"`
 * event back-to-back, synchronously, in a single pass over that chunk —
 * *not* one at a time as some later `await` gets around to asking for the
 * next one. `rl.question()`'s single-shot callback only captures whichever
 * one line happens to be "current" at the moment it's called, so any line
 * that arrives in that same synchronous burst *before* the next
 * `question()` call is re-armed (which only happens once our `await`
 * resumes, a microtask tick later) is silently dropped — invisible on a
 * slow interactive terminal where a human can't literally type two lines
 * in zero milliseconds, but a real bug against a piped/scripted input,
 * exactly the shape `watch`'s own test suite (and real scripted usage)
 * uses. A single persistent `"line"` listener, buffering into this queue,
 * has no such gap: every line is captured the instant it fires, kept in
 * order, and handed out on demand.
 */
function createLineQueue(rl: Interface): { next: () => Promise<string | null> } {
  const buffered: string[] = [];
  const waiting: Array<(value: string | null) => void> = [];
  let closed = false;

  rl.on("line", (line: string) => {
    const resolveWaiting = waiting.shift();
    if (resolveWaiting) {
      resolveWaiting(line);
    } else {
      buffered.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    while (waiting.length > 0) {
      waiting.shift()!(null);
    }
  });

  return {
    next(): Promise<string | null> {
      if (buffered.length > 0) {
        return Promise.resolve(buffered.shift()!);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolveNext) => waiting.push(resolveNext));
    },
  };
}

function formatLoggedLine(entry: LogEntry): string {
  const gitSuffix = entry.gitBranch ? ` (${entry.gitBranch}@${entry.gitCommit})` : "";
  return `✓ Logged [${entry.tag}] ${entry.note}${gitSuffix}\n`;
}

/**
 * Runs the interactive prompt-log-prompt loop against `dir` until a blank
 * line, "exit", "quit", or end-of-input (EOF on piped stdin, or Ctrl-D on a
 * real terminal). Resolves once the loop has ended.
 *
 * Built around a persistent `"line"` listener feeding an async queue
 * (`createLineQueue`) rather than sequential `rl.question()` calls — see
 * that function's doc comment for why: `question()`'s single-shot callback
 * can silently drop a line that arrives in the same synchronous burst as
 * an earlier one, which is exactly what piped/scripted input does.
 */
export async function runWatch(dir: string, options: RunWatchOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, output, terminal: false });
  const lines = createLineQueue(rl);

  output.write(
    "friction-log watch — one line per note, Enter to log it.\n" +
      'End a line with "#tagname" to tag it, e.g. "Docs 404 on first click #friction".\n' +
      "With no inline tag, a keyword-based suggestion may be offered — Enter accepts it, or type a different tag.\n" +
      'Blank line, "exit", or "quit" to stop.\n\n'
  );

  while (true) {
    output.write("> ");
    const line = await lines.next();
    if (line === null) break; // stdin closed mid-prompt (EOF)

    let result: WatchLineResult;
    try {
      result = handleWatchLine(dir, line);
    } catch (err) {
      output.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    if (result.kind === "exit" || result.kind === "empty") {
      break;
    }

    if (result.kind === "needs-tag") {
      output.write(`Suggested tag: ${result.suggestedTag} (Enter to accept, or type a different tag)\n> `);
      const answer = await lines.next();
      if (answer === null) break; // stdin closed while awaiting confirmation
      try {
        const entry = resolveWatchTag(dir, result.note, result.suggestedTag, answer);
        output.write(formatLoggedLine(entry));
      } catch (err) {
        output.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }

    output.write(formatLoggedLine(result.entry));
  }

  rl.close();
  output.write('\nStopped. Run "friction-log list" to see everything you logged.\n');
}
