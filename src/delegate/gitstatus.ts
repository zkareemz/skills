// Detect what actually changed on disk via `git status --porcelain`, which
// catches edits/creates/deletes/renames made by ANY means (including pi's bash
// tool), not just the write/edit tool calls we can see in the event stream.

import { execFileSync } from "node:child_process";
import type { FileChange } from "./types.js";

/** Raw porcelain lines (e.g. " M src/x.ts"), or null if git can't report. */
export function porcelain(cwd: string): string[] | null {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Files changed between two porcelain snapshots — i.e. excluding entries that
 * were already dirty (and unchanged) before the run. Returns null when git
 * couldn't report after the run, so the caller can fall back to tool events.
 */
export function porcelainDelta(before: string[] | null, after: string[] | null): FileChange[] | null {
  if (after === null) return null;
  const beforeSet = new Set(before ?? []);
  const out: FileChange[] = [];
  for (const line of after) {
    if (beforeSet.has(line)) continue;
    out.push(classify(line));
  }
  return out;
}

function classify(line: string): FileChange {
  const status = line.slice(0, 2);
  let rest = line.slice(3);
  const arrow = rest.indexOf(" -> "); // renames: "old -> new"
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  const path = unquote(rest);

  let kind: FileChange["kind"];
  if (status === "??" || status.includes("A")) kind = "create";
  else if (status.includes("R")) kind = "rename";
  else if (status.includes("D")) kind = "delete";
  else kind = "modify";
  return { path, kind };
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string; // git C-style quoting is JSON-compatible enough
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

/** Union git-detected changes (authoritative for disk) with tool-event paths. */
export function mergeChanges(
  gitChanges: FileChange[] | null,
  toolChanges: FileChange[],
): FileChange[] {
  if (gitChanges === null) return toolChanges;
  const seen = new Set(gitChanges.map((c) => c.path));
  return [...gitChanges, ...toolChanges.filter((c) => !seen.has(c.path))];
}
