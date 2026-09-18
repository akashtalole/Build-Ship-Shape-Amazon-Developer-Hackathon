/**
 * End-to-end smoke test for the friction-log CLI.
 *
 * This invokes the *built* CLI (dist/cli.js) as a real subprocess against an
 * isolated temp directory, using Node's built-in child_process + fs/os —
 * no mocks. Run `npm run build` before this (or just `npm test`, which does
 * both).
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { handleWatchLine, resolveWatchTag } from "../dist/watch.js";
import { mergeEntries } from "../dist/commands.js";
import { suggestTag } from "../dist/autotag.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`✓ ${label}`);
}

function runCli(cwd: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number | null };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

/** Same as runCli, but pipes `input` to the child's stdin — used for `watch`. */
function runCliWithInput(cwd: string, args: string[], input: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd,
      encoding: "utf8",
      input,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number | null };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

/**
 * Same as `runCli`, but non-blocking (`child_process.spawn` + a `Promise`
 * instead of `execFileSync`). Required specifically for `sync` here: the
 * fake remote it talks to (`createFakeRemote`, below) is a real
 * `node:http` server hosted *in this same test process* — if the CLI
 * invocation that talks to it were run via the blocking `execFileSync`,
 * this process's event loop (and therefore the fake remote's own request
 * handler) would be frozen for the child's entire lifetime, and the child
 * would hang forever waiting for a response this same process can never
 * get around to sending. `spawn` keeps this process's event loop free
 * while the child runs, so the fake remote can actually answer.
 */
function runCliAsync(cwd: string, args: string[]): Promise<{ stdout: string; status: number }> {
  return new Promise((resolveRun) => {
    const child = spawn("node", [CLI_PATH, ...args], { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolveRun({ stdout, status: code ?? 1 });
    });
  });
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "friction-log-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs a real `git` command in `dir`, used only to set up fixtures for the git-aware tagging tests. */
function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function initGitRepo(dir: string, branch: string): void {
  runGit(dir, ["init", "-b", branch]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Friction Log Test"]);
  writeFileSync(join(dir, "README.md"), "test fixture\n", "utf8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "initial commit"]);
}

function readLogFileRaw(dir: string): { entries: any[]; [key: string]: unknown } {
  return JSON.parse(readFileSync(join(dir, ".friction-log.json"), "utf8"));
}

/**
 * A tiny stand-in "remote" for `sync` tests: a real `node:http` server
 * (not a mock of `fetch`) that speaks exactly the JSON contract `sync.ts`
 * documents — GET returns `{entries}`, POST accepts `{entries}` and merges
 * them into its own in-memory store via the *same* `mergeEntries` the real
 * CLI's `merge`/`sync` use, returning `{added, duplicates, total}`. Reusing
 * `mergeEntries` here (rather than writing a second ad hoc dedup) is
 * deliberate — it's exactly the "safe to run repeatedly" contract a real
 * remote would need to uphold too.
 */
function createFakeRemote(): { server: ReturnType<typeof createServer>; getEntries: () => any[] } {
  let store: any[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries: store }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const incoming = Array.isArray(parsed.entries) ? parsed.entries : [];
          const result = mergeEntries(store, incoming);
          store = result.entries;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ added: result.added, duplicates: result.duplicates, total: result.entries.length }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return { server, getEntries: () => store };
}

function listenOnEphemeralPort(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort) => {
    server.listen(0, () => {
      const address = server.address();
      resolvePort(address && typeof address !== "string" ? address.port : 0);
    });
  });
}

if (!existsSync(CLI_PATH)) {
  console.error(`Built CLI not found at ${CLI_PATH}. Run "npm run build" first.`);
  process.exit(1);
}

// --- Edge case: add before init fails clearly, no bad file created ---
withTempDir((dir) => {
  const result = runCli(dir, ["add", "some note"]);
  check("add before init exits non-zero", () => {
    assert.notEqual(result.status, 0);
  });
  check("add before init does not create a log file", () => {
    assert.equal(existsSync(join(dir, ".friction-log.json")), false);
  });
});

// --- Edge case: list before init also fails clearly ---
withTempDir((dir) => {
  const result = runCli(dir, ["list"]);
  check("list before init exits non-zero", () => {
    assert.notEqual(result.status, 0);
  });
});

// --- Edge case: init twice without --force refuses to clobber ---
withTempDir((dir) => {
  const first = runCli(dir, ["init"]);
  check("first init succeeds", () => {
    assert.equal(first.status, 0);
  });
  const contentsAfterFirst = readFileSync(join(dir, ".friction-log.json"), "utf8");

  const second = runCli(dir, ["init"]);
  check("second init without --force exits non-zero", () => {
    assert.notEqual(second.status, 0);
  });
  check("second init without --force does not modify the existing log", () => {
    const contentsAfterSecond = readFileSync(join(dir, ".friction-log.json"), "utf8");
    assert.equal(contentsAfterSecond, contentsAfterFirst);
  });

  const forced = runCli(dir, ["init", "--force"]);
  check("init --force succeeds even when a log already exists", () => {
    assert.equal(forced.status, 0);
  });
});

// --- Edge case: exporting an empty log produces valid, sensible Markdown ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  const result = runCli(dir, ["export"]);
  check("export on empty log exits zero", () => {
    assert.equal(result.status, 0);
  });
  check("export on empty log still has all section headings", () => {
    assert.match(result.stdout, /## What worked well/);
    assert.match(result.stdout, /## Friction encountered/);
    assert.match(result.stdout, /## Feature requests/);
    assert.match(result.stdout, /## Other notes/);
  });
  check("export on empty log does not crash with entry-related text", () => {
    assert.match(result.stdout, /No entries logged yet/);
  });
});

// --- Golden path: init -> add several tagged entries -> list -> export ---
withTempDir((dir) => {
  const initResult = runCli(dir, ["init"]);
  check("golden path: init succeeds", () => {
    assert.equal(initResult.status, 0);
  });

  const addWorked = runCli(dir, [
    "add",
    "Ring API sandbox mode made local testing painless",
    "--tag",
    "worked-well",
  ]);
  const addFriction1 = runCli(dir, [
    "add",
    "Alexa+ skill schema validation errors had no line numbers",
    "--tag",
    "friction",
  ]);
  const addFriction2 = runCli(dir, [
    "add",
    "OAuth token refresh docs were split across three pages",
    "--tag",
    "friction",
  ]);
  const addFeature = runCli(dir, [
    "add",
    "Wish the CLI scaffold included a devcontainer",
    "--tag",
    "feature-request",
  ]);
  const addUntagged = runCli(dir, ["add", "Random observation with no tag"]);

  check("golden path: all adds succeed", () => {
    for (const r of [addWorked, addFriction1, addFriction2, addFeature, addUntagged]) {
      assert.equal(r.status, 0);
    }
  });

  const listAll = runCli(dir, ["list"]);
  check("golden path: list shows all 5 entries", () => {
    const lines = listAll.stdout.trim().split("\n");
    assert.equal(lines.length, 5);
  });

  const listFriction = runCli(dir, ["list", "--tag", "friction"]);
  check("golden path: list --tag friction shows only the 2 friction entries", () => {
    const lines = listFriction.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.startsWith("[friction]")));
  });

  const listNote = runCli(dir, ["list", "--tag", "note"]);
  check("golden path: untagged add defaults to the 'note' tag", () => {
    const lines = listNote.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Random observation with no tag/);
  });

  const outFile = join(dir, "FRICTION_LOG.md");
  const exportResult = runCli(dir, ["export", "--out", outFile, "--title", "Test Team Friction Log"]);
  check("golden path: export --out succeeds", () => {
    assert.equal(exportResult.status, 0);
  });
  check("golden path: export writes the file", () => {
    assert.equal(existsSync(outFile), true);
  });

  const markdown = readFileSync(outFile, "utf8");
  check("golden path: exported title is used as the H1", () => {
    assert.match(markdown, /^# Test Team Friction Log/);
  });
  check("golden path: worked-well entry appears under 'What worked well'", () => {
    const section = markdown.split("## Friction encountered")[0];
    assert.match(section, /Ring API sandbox mode made local testing painless/);
  });
  check("golden path: both friction entries appear numbered under 'Friction encountered'", () => {
    const section = markdown.split("## Friction encountered")[1].split("## Feature requests")[0];
    assert.match(section, /1\. Alexa\+ skill schema validation errors had no line numbers/);
    assert.match(section, /2\. OAuth token refresh docs were split across three pages/);
  });
  check("golden path: feature request appears under 'Feature requests'", () => {
    const section = markdown.split("## Feature requests")[1].split("## Other notes")[0];
    assert.match(section, /Wish the CLI scaffold included a devcontainer/);
  });
  check("golden path: untagged note appears under 'Other notes'", () => {
    const section = markdown.split("## Other notes")[1];
    assert.match(section, /Random observation with no tag/);
  });
});

// --- Feature: `stats` ---
withTempDir((dir) => {
  runCli(dir, ["init"]);

  const emptyStats = runCli(dir, ["stats"]);
  check("stats on empty log exits zero", () => {
    assert.equal(emptyStats.status, 0);
  });
  check("stats on empty log reports zero total entries", () => {
    assert.match(emptyStats.stdout, /Total entries: 0/);
  });

  runCli(dir, ["add", "Ring API sandbox mode made local testing painless", "--tag", "worked-well"]);
  runCli(dir, ["add", "Alexa+ schema errors had no line numbers", "--tag", "friction"]);
  runCli(dir, ["add", "OAuth refresh docs were split across pages", "--tag", "friction"]);

  const result = runCli(dir, ["stats"]);
  check("stats exits zero with entries present", () => {
    assert.equal(result.status, 0);
  });
  check("stats reports the correct total entry count", () => {
    assert.match(result.stdout, /Total entries: 3/);
  });
  check("stats breaks counts down per tag", () => {
    assert.match(result.stdout, /friction: 2/);
    assert.match(result.stdout, /worked-well: 1/);
  });
  check("stats reports a date range", () => {
    assert.match(result.stdout, /Date range: .+ -> .+/);
  });
  check("stats reports the busiest day", () => {
    assert.match(result.stdout, /Busiest day: \d{4}-\d{2}-\d{2} \(3 entries\)/);
  });
});

// --- Feature: config file defaults (.friction-logrc.json) ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  writeFileSync(
    join(dir, ".friction-logrc.json"),
    JSON.stringify({ defaultTag: "friction", export: { title: "Configured Title", format: "txt" } }),
    "utf8"
  );

  runCli(dir, ["add", "Note with no --tag flag"]);
  const log1 = readLogFileRaw(dir);
  check("config defaultTag is used when --tag is omitted", () => {
    assert.equal(log1.entries[0].tag, "friction");
  });

  runCli(dir, ["add", "Note with explicit tag", "--tag", "worked-well"]);
  const log2 = readLogFileRaw(dir);
  check("an explicit --tag overrides the config defaultTag", () => {
    assert.equal(log2.entries[1].tag, "worked-well");
  });

  const exportNoFlags = runCli(dir, ["export"]);
  check("config export.title is used when --title is omitted", () => {
    assert.match(exportNoFlags.stdout, /^Configured Title/);
  });
  check("config export.format is used when --format is omitted (plain text, no Markdown headings)", () => {
    assert.doesNotMatch(exportNoFlags.stdout, /^# /m);
    assert.match(exportNoFlags.stdout, /FRICTION ENCOUNTERED/);
  });

  const exportWithFlags = runCli(dir, ["export", "--title", "Override Title", "--format", "md"]);
  check("a CLI flag overrides the config default for that same option", () => {
    assert.match(exportWithFlags.stdout, /^# Override Title/);
  });
});

// --- Feature: multiple export formats ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  runCli(dir, ["add", "Something that worked", "--tag", "worked-well"]);
  runCli(dir, ["add", "Something that broke", "--tag", "friction"]);

  const jsonResult = runCli(dir, ["export", "--format", "json"]);
  check("export --format json exits zero", () => {
    assert.equal(jsonResult.status, 0);
  });
  const parsed = JSON.parse(jsonResult.stdout);
  check("export --format json produces an array of raw entry objects", () => {
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].note, "Something that worked");
    assert.equal(parsed[1].tag, "friction");
    assert.ok(typeof parsed[0].id === "string" && parsed[0].id.length > 0);
  });

  const txtResult = runCli(dir, ["export", "--format", "txt"]);
  check("export --format txt exits zero", () => {
    assert.equal(txtResult.status, 0);
  });
  check("export --format txt has no Markdown syntax", () => {
    assert.doesNotMatch(txtResult.stdout, /^#/m);
    assert.doesNotMatch(txtResult.stdout, /_\(/);
  });
  check("export --format txt still groups entries under plain-text section headings", () => {
    assert.match(txtResult.stdout, /WHAT WORKED WELL/);
    assert.match(txtResult.stdout, /FRICTION ENCOUNTERED/);
    assert.match(txtResult.stdout, /Something that worked/);
    assert.match(txtResult.stdout, /Something that broke/);
  });

  const mdResult = runCli(dir, ["export"]);
  check("export with no --format still defaults to Markdown", () => {
    assert.match(mdResult.stdout, /^# Friction Log/);
  });

  const badFormat = runCli(dir, ["export", "--format", "yaml"]);
  check("export with an unknown --format exits non-zero", () => {
    assert.notEqual(badFormat.status, 0);
  });
});

// --- Feature: git-aware tagging (inside a real git repo) ---
withTempDir((dir) => {
  initGitRepo(dir, "flt-test-branch");
  const expectedCommit = runGit(dir, ["rev-parse", "--short", "HEAD"]);

  runCli(dir, ["init"]);
  const addResult = runCli(dir, ["add", "Captured while on a feature branch"]);
  check("add inside a git repo exits zero", () => {
    assert.equal(addResult.status, 0);
  });

  const log = readLogFileRaw(dir);
  check("add inside a git repo records the current branch name", () => {
    assert.equal(log.entries[0].gitBranch, "flt-test-branch");
  });
  check("add inside a git repo records the current short commit hash", () => {
    assert.equal(log.entries[0].gitCommit, expectedCommit);
  });
  check("the CLI's add confirmation surfaces the captured git info", () => {
    assert.match(addResult.stdout, new RegExp(`flt-test-branch@${expectedCommit}`));
  });
});

// --- Feature: git-aware tagging no-ops gracefully outside a git repo ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  const addResult = runCli(dir, ["add", "Captured with no git repo around"]);
  check("add outside a git repo still exits zero (no error)", () => {
    assert.equal(addResult.status, 0);
  });
  const log = readLogFileRaw(dir);
  check("add outside a git repo omits gitBranch/gitCommit entirely, rather than erroring", () => {
    assert.equal(Object.prototype.hasOwnProperty.call(log.entries[0], "gitBranch"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(log.entries[0], "gitCommit"), false);
  });
});

// --- Feature: `edit` and `remove` ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  runCli(dir, ["add", "Original note", "--tag", "note"]);
  const id = readLogFileRaw(dir).entries[0].id as string;

  const editResult = runCli(dir, ["edit", id, "--note", "Updated note", "--tag", "worked-well"]);
  check("edit on an existing id exits zero", () => {
    assert.equal(editResult.status, 0);
  });
  const afterEdit = readLogFileRaw(dir);
  check("edit updates the note text", () => {
    assert.equal(afterEdit.entries[0].note, "Updated note");
  });
  check("edit updates the tag", () => {
    assert.equal(afterEdit.entries[0].tag, "worked-well");
  });
  check("edit preserves the entry id", () => {
    assert.equal(afterEdit.entries[0].id, id);
  });

  const editMissing = runCli(dir, ["edit", "doesnotexist", "--tag", "friction"]);
  check("edit on an unknown id exits non-zero with a clear message", () => {
    assert.notEqual(editMissing.status, 0);
  });

  const removeResult = runCli(dir, ["remove", id]);
  check("remove on an existing id exits zero", () => {
    assert.equal(removeResult.status, 0);
  });
  check("remove actually deletes the entry", () => {
    assert.equal(readLogFileRaw(dir).entries.length, 0);
  });

  const removeAgain = runCli(dir, ["remove", id]);
  check("removing an already-removed id exits non-zero", () => {
    assert.notEqual(removeAgain.status, 0);
  });
});

// --- Feature: `merge` with id-based de-duplication ---
withTempDir((dirA) => {
  withTempDir((dirB) => {
    runCli(dirA, ["init"]);
    runCli(dirA, ["add", "Shared entry logged on machine A first"]);

    // Simulate dirB starting from the same log (e.g. cloned from a shared branch)
    // before the two diverge — copy A's log verbatim, id and all, into B.
    writeFileSync(join(dirB, ".friction-log.json"), readFileSync(join(dirA, ".friction-log.json")));

    runCli(dirA, ["add", "A-only entry one", "--tag", "friction"]);
    runCli(dirA, ["add", "A-only entry two", "--tag", "worked-well"]);
    runCli(dirB, ["add", "B-only entry", "--tag", "feature-request"]);

    const beforeMerge = readLogFileRaw(dirB);
    check("merge fixture: target starts with 2 entries (shared + B-only)", () => {
      assert.equal(beforeMerge.entries.length, 2);
    });

    const mergeResult = runCli(dirB, [
      "merge",
      join(dirA, ".friction-log.json"),
      "--into",
      join(dirB, ".friction-log.json"),
    ]);
    check("merge exits zero", () => {
      assert.equal(mergeResult.status, 0);
    });
    check("merge reports the correct added/duplicate/total counts", () => {
      assert.match(mergeResult.stdout, /\+2 new, 1 duplicate\(s\) skipped, 4 total/);
    });

    const merged = readLogFileRaw(dirB);
    check("merge de-duplicates by entry id instead of concatenating blindly", () => {
      const notes = merged.entries.map((e: any) => e.note);
      assert.equal(merged.entries.length, 4);
      assert.equal(notes.filter((n: string) => n === "Shared entry logged on machine A first").length, 1);
      assert.ok(notes.includes("A-only entry one"));
      assert.ok(notes.includes("A-only entry two"));
      assert.ok(notes.includes("B-only entry"));
    });

    const missingSource = runCli(dirB, ["merge", join(dirB, "nope.json"), "--into", join(dirB, ".friction-log.json")]);
    check("merge with a nonexistent source file exits non-zero with a clear message", () => {
      assert.notEqual(missingSource.status, 0);
    });
  });
});

// --- Feature: `search` ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  runCli(dir, ["add", "Alexa+ schema validation errors had no line numbers", "--tag", "friction"]);
  runCli(dir, ["add", "Ring API sandbox mode made local testing painless", "--tag", "worked-well"]);
  runCli(dir, ["add", "OAuth token refresh docs were split across three pages", "--tag", "friction"]);

  const hit = runCli(dir, ["search", "line numbers"]);
  check("search finds a known entry by case-insensitive substring", () => {
    assert.equal(hit.status, 0);
    assert.match(hit.stdout, /Alexa\+ schema validation errors had no line numbers/);
  });
  check("search excludes non-matching entries", () => {
    assert.doesNotMatch(hit.stdout, /Ring API sandbox mode/);
    assert.doesNotMatch(hit.stdout, /OAuth token refresh/);
  });

  const caseInsensitive = runCli(dir, ["search", "LINE NUMBERS"]);
  check("search matching is case-insensitive", () => {
    assert.match(caseInsensitive.stdout, /Alexa\+ schema validation errors had no line numbers/);
  });

  const narrowed = runCli(dir, ["search", "docs", "--tag", "friction"]);
  check("search --tag narrows to the matching tag", () => {
    assert.match(narrowed.stdout, /OAuth token refresh docs were split across three pages/);
  });

  const narrowedMiss = runCli(dir, ["search", "docs", "--tag", "worked-well"]);
  check("search --tag excludes a textual match outside the requested tag", () => {
    assert.doesNotMatch(narrowedMiss.stdout, /OAuth token refresh/);
    assert.match(narrowedMiss.stdout, /No entries matching/);
  });

  const noMatch = runCli(dir, ["search", "no-such-substring-anywhere"]);
  check("search with no matches exits zero and says so", () => {
    assert.equal(noMatch.status, 0);
    assert.match(noMatch.stdout, /No entries matching/);
  });
});

// --- Feature: `--since`/`--until` date-range filtering on list/export/stats ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  runCli(dir, ["add", "In-range entry one", "--tag", "friction"]);
  runCli(dir, ["add", "In-range entry two", "--tag", "worked-well"]);

  // Backdate one entry far in the past and one far in the future by editing
  // the log file directly (the CLI has no way to set a timestamp, and these
  // are real ISO-8601 boundaries a --since/--until filter must actually
  // respect, not something a mocked clock would exercise more honestly).
  const raw = readLogFileRaw(dir);
  raw.entries[0].timestamp = "2020-01-01T00:00:00.000Z";
  raw.entries[0].note = "Ancient out-of-range entry";
  writeFileSync(join(dir, ".friction-log.json"), JSON.stringify(raw, null, 2) + "\n", "utf8");
  runCli(dir, ["add", "Future out-of-range entry", "--tag", "feature-request"]);
  const raw2 = readLogFileRaw(dir);
  raw2.entries[raw2.entries.length - 1].timestamp = "2099-01-01T00:00:00.000Z";
  writeFileSync(join(dir, ".friction-log.json"), JSON.stringify(raw2, null, 2) + "\n", "utf8");

  const today = new Date().toISOString().slice(0, 10);

  const sinceUntilToday = runCli(dir, ["list", "--since", today, "--until", today]);
  check("list --since/--until narrows to entries within today's range", () => {
    assert.match(sinceUntilToday.stdout, /In-range entry two/);
    assert.doesNotMatch(sinceUntilToday.stdout, /Ancient out-of-range entry/);
    assert.doesNotMatch(sinceUntilToday.stdout, /Future out-of-range entry/);
  });

  const sinceFuture = runCli(dir, ["list", "--since", "2099-06-01"]);
  check("list --since excludes everything before the given date", () => {
    assert.match(sinceFuture.stdout, /No entries logged yet in range/);
  });

  const untilPast = runCli(dir, ["list", "--until", "2019-01-01"]);
  check("list --until excludes everything after the given date", () => {
    assert.match(untilPast.stdout, /No entries logged yet in range/);
  });

  const exportRanged = runCli(dir, ["export", "--since", today, "--until", today]);
  check("export --since/--until filters entries before grouping into sections", () => {
    assert.match(exportRanged.stdout, /In-range entry two/);
    assert.doesNotMatch(exportRanged.stdout, /Ancient out-of-range entry/);
    assert.doesNotMatch(exportRanged.stdout, /Future out-of-range entry/);
  });

  const statsRanged = runCli(dir, ["stats", "--since", today, "--until", today]);
  check("stats --since/--until reports totals only for entries in range", () => {
    assert.match(statsRanged.stdout, /Total entries: 1/);
  });

  const statsUnranged = runCli(dir, ["stats"]);
  check("stats with no --since/--until still counts every entry", () => {
    assert.match(statsUnranged.stdout, /Total entries: 3/);
  });

  const badDate = runCli(dir, ["list", "--since", "not-a-real-date"]);
  check("an unparseable --since fails clearly instead of silently matching everything", () => {
    assert.notEqual(badDate.status, 0);
  });
});

// --- Feature: `watch` — the pure line-handling logic, tested directly (as the actual CLI uses it) ---
withTempDir((dir) => {
  runCli(dir, ["init"]);

  const logged = handleWatchLine(dir, "Docs page 404'd on first click");
  check("handleWatchLine logs a plain line with the default tag", () => {
    assert.equal(logged.kind, "logged");
    if (logged.kind === "logged") {
      assert.equal(logged.entry.tag, "note");
      assert.equal(logged.entry.note, "Docs page 404'd on first click");
    }
  });

  const tagged = handleWatchLine(dir, "Schema errors had no line numbers #friction");
  check("handleWatchLine strips a trailing #tag and applies it as the entry's tag", () => {
    assert.equal(tagged.kind, "logged");
    if (tagged.kind === "logged") {
      assert.equal(tagged.entry.tag, "friction");
      assert.equal(tagged.entry.note, "Schema errors had no line numbers");
    }
  });

  const blank = handleWatchLine(dir, "   ");
  check('handleWatchLine treats a blank line as "end the loop", not a logged entry', () => {
    assert.equal(blank.kind, "empty");
  });

  const exitWord = handleWatchLine(dir, "exit");
  check('handleWatchLine treats "exit" as an end-of-loop signal', () => {
    assert.equal(exitWord.kind, "exit");
  });

  const quitWord = handleWatchLine(dir, "QUIT");
  check('handleWatchLine treats "quit" (any case) as an end-of-loop signal', () => {
    assert.equal(quitWord.kind, "exit");
  });

  const afterAll = readLogFileRaw(dir);
  check("handleWatchLine actually persisted exactly the two logged entries, not the exit/blank lines", () => {
    assert.equal(afterAll.entries.length, 2);
  });
});

// --- Feature: `watch` — the real CLI command end to end, piping lines into its stdin ---
withTempDir((dir) => {
  runCli(dir, ["init"]);
  const watchResult = runCliWithInput(
    dir,
    ["watch"],
    "First rapid-fire note\nSecond note tagged inline #feature-request\n\n"
  );
  check("friction-log watch exits zero after its input ends", () => {
    assert.equal(watchResult.status, 0);
  });
  check("friction-log watch echoes a confirmation for each logged line", () => {
    assert.match(watchResult.stdout, /✓ Logged \[note\] First rapid-fire note/);
    assert.match(watchResult.stdout, /✓ Logged \[feature-request\] Second note tagged inline/);
  });
  const entries = readLogFileRaw(dir).entries;
  check("friction-log watch persisted both lines as real entries, correctly tagged", () => {
    assert.equal(entries.length, 2);
    assert.equal(entries[0].tag, "note");
    assert.equal(entries[1].tag, "feature-request");
    assert.equal(entries[1].note, "Second note tagged inline");
  });
});

// --- Feature: `serve` — a real HTTP server on an ephemeral port ---
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "friction-log-test-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    runCli(dir, ["init"]);
    runCli(dir, ["add", "Fire TV emulator has no --reset flag", "--tag", "feature-request"]);
    runCli(dir, ["add", "Ring OAuth sandbox worked first try", "--tag", "worked-well"]);

    child = spawn("node", [CLI_PATH, "serve", "--port", "0"], { cwd: dir });
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = buffer.match(/http:\/\/localhost:(\d+)\//);
        if (match) {
          child!.stdout!.off("data", onData);
          resolvePort(Number(match[1]));
        }
      };
      child!.stdout!.on("data", onData);
      child!.on("error", rejectPort);
      setTimeout(() => rejectPort(new Error("friction-log serve did not print a URL in time")), 5000);
    });

    const response = await fetch(`http://localhost:${port}/`);
    const html = await response.text();
    check("serve responds 200 with HTML containing a known entry's text", () => {
      assert.equal(response.status, 200);
      assert.match(html, /Fire TV emulator has no --reset flag/);
      assert.match(html, /Ring OAuth sandbox worked first try/);
    });

    const filteredResponse = await fetch(`http://localhost:${port}/?tag=feature-request`);
    const filteredHtml = await filteredResponse.text();
    check("serve's tag filter narrows the rendered entries", () => {
      assert.match(filteredHtml, /Fire TV emulator has no --reset flag/);
      assert.doesNotMatch(filteredHtml, /Ring OAuth sandbox worked first try/);
    });

    runCli(dir, ["add", "Added after the server was already running", "--tag", "note"]);
    const liveResponse = await fetch(`http://localhost:${port}/`);
    const liveHtml = await liveResponse.text();
    check("serve reflects a freshly-added entry with no restart (re-reads the file, no caching)", () => {
      assert.match(liveHtml, /Added after the server was already running/);
    });
  } finally {
    if (child) {
      child.kill("SIGTERM");
    }
    rmSync(dir, { recursive: true, force: true });
  }
})();

// --- Feature: auto-tag suggestion heuristic (unit-level, direct against `suggestTag`) ---
withTempDir(() => {
  check('suggestTag suggests "friction" for bug/error/crash-flavored text', () => {
    assert.equal(suggestTag("The build broke halfway through"), "friction");
    assert.equal(suggestTag("Getting a weird error on every request"), "friction");
    assert.equal(suggestTag("The emulator crashed twice this morning"), "friction");
  });
  check('suggestTag suggests "worked-well" for smooth/clean-flavored text', () => {
    assert.equal(suggestTag("OAuth sandbox worked first try"), "worked-well");
    assert.equal(suggestTag("That refactor came out really clean"), "worked-well");
    assert.equal(suggestTag("Setup was painless this time"), "worked-well");
  });
  check('suggestTag suggests "feature-request" for wish/should-flavored text', () => {
    assert.equal(suggestTag("I wish this had better docs"), "feature-request");
    assert.equal(suggestTag("This should really have a --dry-run flag"), "feature-request");
    assert.equal(suggestTag("Could use a devcontainer for this"), "feature-request");
  });
  check("suggestTag returns undefined for text matching no keyword list", () => {
    assert.equal(suggestTag("Just a plain observation with no signal words"), undefined);
  });
});

// --- Feature: auto-tag suggestion applied automatically by non-interactive `add` ---
withTempDir((dir) => {
  runCli(dir, ["init"]);

  const frictionAdd = runCli(dir, ["add", "The build broke halfway through"]);
  check("add with no --tag and friction-flavored text exits zero", () => {
    assert.equal(frictionAdd.status, 0);
  });
  check("add auto-assigns the friction tag and says so in its output (not a silent surprise)", () => {
    assert.match(frictionAdd.stdout, /^✓ Logged \[friction\] The build broke halfway through/);
    assert.match(frictionAdd.stdout, /auto-tagged "friction"/);
  });

  const workedWellAdd = runCli(dir, ["add", "OAuth sandbox worked first try"]);
  check("add auto-assigns worked-well for smooth-flavored text with no --tag", () => {
    assert.match(workedWellAdd.stdout, /^✓ Logged \[worked-well\] OAuth sandbox worked first try/);
    assert.match(workedWellAdd.stdout, /auto-tagged "worked-well"/);
  });

  const featureAdd = runCli(dir, ["add", "I wish this had better docs"]);
  check("add auto-assigns feature-request for wish-flavored text with no --tag", () => {
    assert.match(featureAdd.stdout, /^✓ Logged \[feature-request\] I wish this had better docs/);
    assert.match(featureAdd.stdout, /auto-tagged "feature-request"/);
  });

  const plainAdd = runCli(dir, ["add", "Just a plain observation with no signal words"]);
  check("add with no --tag and no keyword match still falls back to the default 'note' tag", () => {
    assert.match(plainAdd.stdout, /^✓ Logged \[note\] Just a plain observation with no signal words/);
  });
  check("add's output carries no auto-tag notice when nothing was actually auto-tagged", () => {
    assert.doesNotMatch(plainAdd.stdout, /auto-tagged/);
  });

  const explicitTagAdd = runCli(dir, ["add", "The build broke again", "--tag", "note"]);
  check("an explicit --tag is never overridden by the auto-tag heuristic, and carries no auto-tag notice", () => {
    assert.match(explicitTagAdd.stdout, /^✓ Logged \[note\] The build broke again/);
    assert.doesNotMatch(explicitTagAdd.stdout, /auto-tagged/);
  });

  const log = readLogFileRaw(dir);
  check("every auto-tagged entry actually persisted with the suggested tag, not just in stdout", () => {
    assert.equal(log.entries[0].tag, "friction");
    assert.equal(log.entries[2].tag, "feature-request");
  });
});

// --- Feature: auto-tag suggestion in `watch` — interactive accept (Enter) and override ---
withTempDir((dir) => {
  runCli(dir, ["init"]);

  const acceptResult = runCliWithInput(dir, ["watch"], "The API errored constantly\n\nexit\n");
  check("friction-log watch exits zero after accepting a suggested tag", () => {
    assert.equal(acceptResult.status, 0);
  });
  check("friction-log watch shows the suggested tag before logging it", () => {
    assert.match(acceptResult.stdout, /Suggested tag: friction/);
  });
  check("friction-log watch logs with the suggested tag when the confirmation answer is blank (Enter)", () => {
    assert.match(acceptResult.stdout, /✓ Logged \[friction\] The API errored constantly/);
  });

  const overrideResult = runCliWithInput(dir, ["watch"], "This crashed twice today\ncustom-tag\nexit\n");
  check("friction-log watch exits zero after overriding a suggested tag", () => {
    assert.equal(overrideResult.status, 0);
  });
  check("friction-log watch uses a typed answer instead of the suggestion when one is given", () => {
    assert.match(overrideResult.stdout, /Suggested tag: friction/);
    assert.match(overrideResult.stdout, /✓ Logged \[custom-tag\] This crashed twice today/);
  });

  const plainResult = runCliWithInput(dir, ["watch"], "A plain note with no signal words\nexit\n");
  check("friction-log watch never prompts for confirmation when there's no keyword suggestion", () => {
    assert.doesNotMatch(plainResult.stdout, /Suggested tag:/);
    assert.match(plainResult.stdout, /✓ Logged \[note\] A plain note with no signal words/);
  });

  const entries = readLogFileRaw(dir).entries;
  check("all three watch sessions persisted exactly the entries described above", () => {
    assert.equal(entries.length, 3);
    assert.equal(entries[0].tag, "friction");
    assert.equal(entries[1].tag, "custom-tag");
    assert.equal(entries[2].tag, "note");
  });
});

// --- Feature: auto-tag suggestion — pure `handleWatchLine`/`resolveWatchTag` unit tests ---
withTempDir((dir) => {
  runCli(dir, ["init"]);

  const needsTag = handleWatchLine(dir, "The deploy script broke midway");
  check("handleWatchLine returns needs-tag (not logged yet) for friction-flavored text with no inline tag", () => {
    assert.equal(needsTag.kind, "needs-tag");
    if (needsTag.kind === "needs-tag") {
      assert.equal(needsTag.suggestedTag, "friction");
      assert.equal(needsTag.note, "The deploy script broke midway");
    }
  });
  check("handleWatchLine does not persist anything for a needs-tag result until resolved", () => {
    assert.equal(readLogFileRaw(dir).entries.length, 0);
  });

  if (needsTag.kind === "needs-tag") {
    const accepted = resolveWatchTag(dir, needsTag.note, needsTag.suggestedTag, "");
    check("resolveWatchTag accepts the suggested tag on a blank answer", () => {
      assert.equal(accepted.tag, "friction");
      assert.equal(accepted.note, "The deploy script broke midway");
    });
  }

  const overridden = resolveWatchTag(dir, "Something else that broke", "friction", "custom-tag");
  check("resolveWatchTag uses the typed answer instead of the suggestion when one is given", () => {
    assert.equal(overridden.tag, "custom-tag");
  });

  check("an inline #tag always short-circuits the suggestion, even on friction-flavored text", () => {
    const inlineTagged = handleWatchLine(dir, "This crashed again #friction");
    assert.equal(inlineTagged.kind, "logged");
    if (inlineTagged.kind === "logged") {
      assert.equal(inlineTagged.entry.tag, "friction");
    }
  });
});

// --- Feature: `stats` ASCII bar chart ---
withTempDir((dir) => {
  runCli(dir, ["init"]);

  const emptyChart = runCli(dir, ["stats"]);
  check("stats on an empty log prints no 'Daily activity' section", () => {
    assert.doesNotMatch(emptyChart.stdout, /Daily activity/);
  });

  // Six entries across three days with counts 1 / 3 / 2, tagged explicitly
  // so the auto-tag heuristic can't reassign any of them and complicate
  // the chart assertions below.
  for (const note of [
    "Day one entry",
    "Day two entry A",
    "Day two entry B",
    "Day two entry C",
    "Day three entry A",
    "Day three entry B",
  ]) {
    runCli(dir, ["add", note, "--tag", "note"]);
  }

  const raw = readLogFileRaw(dir);
  const timestamps = [
    "2026-01-01T10:00:00.000Z",
    "2026-01-02T09:00:00.000Z",
    "2026-01-02T10:00:00.000Z",
    "2026-01-02T11:00:00.000Z",
    "2026-01-03T09:00:00.000Z",
    "2026-01-03T10:00:00.000Z",
  ];
  raw.entries.forEach((e: any, i: number) => {
    e.timestamp = timestamps[i];
  });
  writeFileSync(join(dir, ".friction-log.json"), JSON.stringify(raw, null, 2) + "\n", "utf8");

  const result = runCli(dir, ["stats"]);
  check("stats prints a 'Daily activity' section once entries exist", () => {
    assert.match(result.stdout, /Daily activity:/);
  });
  check("stats chart renders one line per day with the correct raw count", () => {
    assert.match(result.stdout, /2026-01-01 \|█ 1/);
    assert.match(result.stdout, /2026-01-02 \|███ 3/);
    assert.match(result.stdout, /2026-01-03 \|██ 2/);
  });
  check("stats chart bars are proportional to count (day with 3 entries has the longest bar)", () => {
    const barLength = (line: string) => (line.match(/█/g) ?? []).length;
    const lines = result.stdout.split("\n");
    // Match the chart line specifically (" |") — "Date range: ..." above it
    // also contains these dates as plain timestamps, with no bar at all.
    const day1 = lines.find((l) => l.includes("2026-01-01 |"))!;
    const day2 = lines.find((l) => l.includes("2026-01-02 |"))!;
    const day3 = lines.find((l) => l.includes("2026-01-03 |"))!;
    assert.equal(barLength(day1), 1);
    assert.equal(barLength(day2), 3);
    assert.equal(barLength(day3), 2);
    assert.ok(barLength(day2) > barLength(day3) && barLength(day3) > barLength(day1));
  });
});

// --- Feature: entry templates (`template add` / `template use` / `template list`) ---
withTempDir((dir) => {
  runCli(dir, ["init"]);

  const emptyList = runCli(dir, ["template", "list"]);
  check("template list on a fresh directory reports no templates saved yet", () => {
    assert.equal(emptyList.status, 0);
    assert.match(emptyList.stdout, /No templates saved yet/);
  });

  const addResult = runCli(dir, [
    "template",
    "add",
    "docs-404",
    "Docs page for {feature} 404'd on first click",
    "--tag",
    "friction",
  ]);
  check("template add exits zero and confirms the saved name, tag, and text", () => {
    assert.equal(addResult.status, 0);
    assert.match(addResult.stdout, /Saved template "docs-404"/);
    assert.match(addResult.stdout, /tag: friction/);
    assert.match(addResult.stdout, /Docs page for \{feature\} 404'd on first click/);
  });

  const listResult = runCli(dir, ["template", "list"]);
  check("template list shows a saved template with its tag and placeholder text", () => {
    assert.match(listResult.stdout, /docs-404 \[friction\]: Docs page for \{feature\} 404'd on first click/);
  });

  const useResult = runCli(dir, ["template", "use", "docs-404", "--set", "feature=OAuth"]);
  check("template use exits zero and logs the filled-in note with the template's own tag", () => {
    assert.equal(useResult.status, 0);
    assert.match(useResult.stdout, /^✓ Logged \[friction\] Docs page for OAuth 404'd on first click/);
  });

  const useOverrideResult = runCli(dir, [
    "template",
    "use",
    "docs-404",
    "--set",
    "feature=Alexa",
    "--tag",
    "worked-well",
  ]);
  check("template use --tag overrides the template's own tag", () => {
    assert.match(useOverrideResult.stdout, /^✓ Logged \[worked-well\] Docs page for Alexa 404'd on first click/);
  });

  const log = readLogFileRaw(dir);
  check("both template use invocations persisted correctly-filled, correctly-tagged entries", () => {
    assert.equal(log.entries.length, 2);
    assert.equal(log.entries[0].note, "Docs page for OAuth 404'd on first click");
    assert.equal(log.entries[0].tag, "friction");
    assert.equal(log.entries[1].note, "Docs page for Alexa 404'd on first click");
    assert.equal(log.entries[1].tag, "worked-well");
  });

  const missingSet = runCli(dir, ["template", "use", "docs-404"]);
  check("template use without --set for a required placeholder exits non-zero", () => {
    assert.notEqual(missingSet.status, 0);
  });

  const unknownTemplate = runCli(dir, ["template", "use", "does-not-exist"]);
  check("template use on an unknown template name exits non-zero with a clear message", () => {
    assert.notEqual(unknownTemplate.status, 0);
  });

  // A template with no tag at all falls through to `add`'s normal default
  // chain (no config default here, and no auto-tag keyword in this note),
  // landing on the hardcoded "note" tag — same as a plain untagged `add`.
  runCli(dir, ["template", "add", "plain", "A neutral observation about {thing}"]);
  const plainUse = runCli(dir, ["template", "use", "plain", "--set", "thing=logging"]);
  check("a template with no tag falls back to add's normal default tag when --tag is also omitted", () => {
    assert.match(plainUse.stdout, /^✓ Logged \[note\] A neutral observation about logging/);
  });

  // Re-adding an existing template name replaces it rather than duplicating.
  runCli(dir, ["template", "add", "docs-404", "Updated: {feature} still 404s", "--tag", "friction"]);
  const afterReplace = runCli(dir, ["template", "list"]);
  check("re-running template add with an existing name replaces it instead of duplicating", () => {
    const matches = afterReplace.stdout.match(/docs-404/g) ?? [];
    assert.equal(matches.length, 1);
    assert.match(afterReplace.stdout, /Updated: \{feature\} still 404s/);
  });
});

// --- Feature: `sync` push/pull round-trip against a local fake remote, with id-based dedup ---
await (async () => {
  const dirA = mkdtempSync(join(tmpdir(), "friction-log-test-"));
  const dirB = mkdtempSync(join(tmpdir(), "friction-log-test-"));
  const { server, getEntries } = createFakeRemote();
  try {
    const port = await listenOnEphemeralPort(server);
    const url = `http://127.0.0.1:${port}/`;

    runCli(dirA, ["init"]);
    runCli(dirA, ["add", "A-side entry one", "--tag", "note"]);
    runCli(dirA, ["add", "A-side entry two", "--tag", "note"]);

    const firstPush = await runCliAsync(dirA, ["sync", url, "--push"]);
    check("sync --push exits zero", () => {
      assert.equal(firstPush.status, 0);
    });
    check("sync --push reports the correct added/duplicate/total counts against an empty remote", () => {
      assert.match(firstPush.stdout, /\+2 new, 0 duplicate\(s\) skipped, 2 total on remote/);
    });
    check("the fake remote actually received both entries via the real HTTP POST", () => {
      assert.equal(getEntries().length, 2);
      const notes = getEntries().map((e: any) => e.note);
      assert.ok(notes.includes("A-side entry one"));
      assert.ok(notes.includes("A-side entry two"));
    });

    const secondPush = await runCliAsync(dirA, ["sync", url, "--push"]);
    check("re-running sync --push is idempotent: no duplicates added on the remote", () => {
      assert.match(secondPush.stdout, /\+0 new, 2 duplicate\(s\) skipped, 2 total on remote/);
      assert.equal(getEntries().length, 2);
    });

    runCli(dirB, ["init"]);
    const firstPull = await runCliAsync(dirB, ["sync", url, "--pull"]);
    check("sync --pull exits zero", () => {
      assert.equal(firstPull.status, 0);
    });
    check("sync --pull reports the correct added/duplicate/total counts into an empty local log", () => {
      assert.match(firstPull.stdout, /\+2 new, 0 duplicate\(s\) skipped, 2 total locally/);
    });
    const bEntriesAfterPull = readLogFileRaw(dirB).entries;
    check("sync --pull actually wrote the remote's entries into the local log file", () => {
      assert.equal(bEntriesAfterPull.length, 2);
      const notes = bEntriesAfterPull.map((e: any) => e.note);
      assert.ok(notes.includes("A-side entry one"));
      assert.ok(notes.includes("A-side entry two"));
    });

    const secondPull = await runCliAsync(dirB, ["sync", url, "--pull"]);
    check("re-running sync --pull is idempotent: no duplicates added locally", () => {
      assert.match(secondPull.stdout, /\+0 new, 2 duplicate\(s\) skipped, 2 total locally/);
      assert.equal(readLogFileRaw(dirB).entries.length, 2);
    });

    runCli(dirB, ["add", "B-side entry", "--tag", "note"]);
    const bPush = await runCliAsync(dirB, ["sync", url, "--push"]);
    check("B's push after pulling A's entries adds only B's new entry, not duplicates of A's", () => {
      assert.match(bPush.stdout, /\+1 new, 2 duplicate\(s\) skipped, 3 total on remote/);
      assert.equal(getEntries().length, 3);
    });

    const aPullBack = await runCliAsync(dirA, ["sync", url, "--pull"]);
    check("pulling again into A brings back only B's genuinely new entry", () => {
      assert.match(aPullBack.stdout, /\+1 new, 2 duplicate\(s\) skipped, 3 total locally/);
    });
    const aEntriesFinal = readLogFileRaw(dirA).entries;
    check("A's log now has all three entries from both sides, round-tripped through the remote", () => {
      assert.equal(aEntriesFinal.length, 3);
      const notes = aEntriesFinal.map((e: any) => e.note);
      assert.ok(notes.includes("A-side entry one"));
      assert.ok(notes.includes("A-side entry two"));
      assert.ok(notes.includes("B-side entry"));
    });

    const noFlag = runCli(dirA, ["sync", url]);
    check("sync with neither --push nor --pull exits non-zero with a clear message", () => {
      assert.notEqual(noFlag.status, 0);
    });

    const bothFlags = runCli(dirA, ["sync", url, "--push", "--pull"]);
    check("sync with both --push and --pull exits non-zero with a clear message", () => {
      assert.notEqual(bothFlags.status, 0);
    });

    const unreachable = runCli(dirA, ["sync", "http://127.0.0.1:1/", "--push"]);
    check("sync against an unreachable URL exits non-zero instead of hanging or crashing uncleanly", () => {
      assert.notEqual(unreachable.status, 0);
    });
  } finally {
    server.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
})();

console.log(`\nAll ${passed} checks passed.`);
