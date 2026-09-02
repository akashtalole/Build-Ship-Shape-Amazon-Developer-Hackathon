#!/usr/bin/env node
import { LogAlreadyExistsError, LogNotFoundError } from "./store.js";
import { add, exportLog, init, list } from "./commands.js";

const USAGE = `friction-log — capture friction points in the moment, export them as a Markdown report.

Usage:
  friction-log init [--force]
  friction-log add "<note>" [--tag <tag>]
  friction-log list [--tag <tag>]
  friction-log export [--out <file>] [--title <title>]

Conventional tags (grouped specially by "export"):
  worked-well       something that went smoothly
  friction          something that slowed you down or broke
  feature-request   something you wish existed

Any other tag (or none, which defaults to "note") lands under "Other notes"
in the exported report.

Examples:
  friction-log init
  friction-log add "Alexa+ skill schema validation errors had no line numbers" --tag friction
  friction-log add "Ring API sandbox mode made local testing painless" --tag worked-well
  friction-log list --tag friction
  friction-log export --out FRICTION_LOG.md --title "Team Rocket — Friction Log"
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

export function run(argv: string[], cwd: string = process.cwd()): void {
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
        console.log(`✓ Logged [${entry.tag}] ${entry.note}`);
        break;
      }

      case "list": {
        const tag = typeof flags.tag === "string" ? flags.tag : undefined;
        const entries = list(cwd, { tag });
        if (entries.length === 0) {
          console.log(tag ? `No entries tagged "${tag}".` : "No entries logged yet.");
          break;
        }
        for (const entry of entries) {
          console.log(`[${entry.tag}] ${entry.timestamp}  ${entry.note}`);
        }
        break;
      }

      case "export": {
        const out = typeof flags.out === "string" ? flags.out : undefined;
        const title = typeof flags.title === "string" ? flags.title : undefined;
        const markdown = exportLog(cwd, { out, title });
        if (out) {
          console.log(`✓ Exported friction log to ${out}`);
        } else {
          console.log(markdown);
        }
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
    if (err instanceof LogNotFoundError || err instanceof LogAlreadyExistsError) {
      fail(err.message);
    }
    if (err instanceof Error) {
      fail(err.message);
    }
    throw err;
  }
}

run(process.argv.slice(2));
