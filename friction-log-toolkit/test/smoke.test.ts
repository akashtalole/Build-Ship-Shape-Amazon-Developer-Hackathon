/**
 * End-to-end smoke test for the friction-log CLI.
 *
 * This invokes the *built* CLI (dist/cli.js) as a real subprocess against an
 * isolated temp directory, using Node's built-in child_process + fs/os —
 * no mocks. Run `npm run build` before this (or just `npm test`, which does
 * both).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

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

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "friction-log-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

console.log(`\nAll ${passed} checks passed.`);
