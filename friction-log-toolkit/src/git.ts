import { execFileSync } from "node:child_process";

export interface GitInfo {
  branch: string;
  commit: string;
}

/**
 * Best-effort capture of the current branch + short commit hash for `add`.
 * Purely informational, so this must never throw or slow things down: it
 * returns undefined (rather than throwing) whenever `git` isn't installed,
 * the directory isn't inside a git repo, or the repo has no commits yet
 * (a fresh `git init` with nothing committed has no HEAD to resolve).
 */
export function getGitInfo(dir: string): GitInfo | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!branch || !commit) return undefined;
    return { branch, commit };
  } catch {
    // Not a git repo, git isn't installed, no commits yet, etc. — no-op.
    return undefined;
  }
}
