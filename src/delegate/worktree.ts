// Git worktree helpers for `--parallel`: each delegate runs in its own worktree
// on a throwaway branch; successful branches are merged back into the repo.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

export interface Worktree {
  dir: string;
  branch: string;
}

export function createWorktree(cwd: string, jobId: string, taskId: string): Worktree {
  const branch = `pidelegate/${jobId}/${taskId}`;
  // git refuses an existing path, so hand it a fresh, non-existent one.
  const dir = join(tmpdir(), `pidg-wt-${jobId}-${taskId}-${randomBytes(4).toString("hex")}`);
  // New branch off current HEAD, checked out in an isolated worktree.
  git(cwd, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { dir, branch };
}

/** Commit all changes in the worktree. Returns true if a commit was created. */
export function commitAll(wtDir: string, message: string): boolean {
  git(wtDir, ["add", "-A"]);
  const status = git(wtDir, ["status", "--porcelain"]);
  if (!status) return false;
  git(wtDir, ["-c", "user.email=pidelegate@local", "-c", "user.name=pidelegate", "commit", "-m", message]);
  return true;
}

export interface MergeOutcome {
  ok: boolean;
  conflict: boolean;
  message?: string;
}

export function mergeBranch(cwd: string, branch: string): MergeOutcome {
  try {
    git(cwd, ["merge", "--no-edit", "--no-ff", branch]);
    return { ok: true, conflict: false };
  } catch (e) {
    // Abort a conflicted merge so the repo is left clean.
    try {
      git(cwd, ["merge", "--abort"]);
    } catch {
      /* nothing to abort */
    }
    return { ok: false, conflict: true, message: (e as Error).message.split("\n")[0] };
  }
}

export function removeWorktree(cwd: string, wt: Worktree): void {
  try {
    git(cwd, ["worktree", "remove", "--force", wt.dir]);
  } catch {
    /* leave it; it's a temp dir */
  }
  try {
    git(cwd, ["branch", "-D", wt.branch]);
  } catch {
    /* branch may have been merged/deleted */
  }
}
