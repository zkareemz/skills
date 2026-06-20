// Global job store under ~/.pidelegate/jobs/<id>/.
//
// Layout per job:
//   meta.json              job metadata (status, options, tasks)
//   result.json            overall rollup (written when terminal)
//   supervisor.log         detached supervisor stdout/stderr
//   abort.flag            presence requests a cooperative abort
//   sessions/<taskId>.jsonl  pi session (for resume / fix-loop)
//   <taskId>/events.jsonl    raw pi event stream for that task
//   <taskId>/result.json     per-task compact result

import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { JobMeta, Brief, JobRollup } from "./types.js";

export function rootDir(): string {
  return process.env.PIDELEGATE_HOME ?? join(homedir(), ".pidelegate");
}

export function jobsDir(): string {
  return join(rootDir(), "jobs");
}

export function jobDir(id: string): string {
  return join(jobsDir(), id);
}

export function taskDir(id: string, taskId: string): string {
  return join(jobDir(id), taskId);
}

export function sessionsDir(id: string): string {
  return join(jobDir(id), "sessions");
}

export function sessionPath(id: string, taskId: string): string {
  return join(sessionsDir(id), `${taskId}.jsonl`);
}

export function eventsPath(id: string, taskId: string): string {
  return join(taskDir(id, taskId), "events.jsonl");
}

export function taskResultPath(id: string, taskId: string): string {
  return join(taskDir(id, taskId), "result.json");
}

export function metaPath(id: string): string {
  return join(jobDir(id), "meta.json");
}

export function resultPath(id: string): string {
  return join(jobDir(id), "result.json");
}

export function supervisorLogPath(id: string): string {
  return join(jobDir(id), "supervisor.log");
}

export function abortFlagPath(id: string): string {
  return join(jobDir(id), "abort.flag");
}

export function newJobId(): string {
  // Short, sortable-ish, collision-safe enough for a local store.
  return randomUUID().slice(0, 8);
}

export function ensureJobDirs(id: string, taskIds: string[]): void {
  mkdirSync(join(jobDir(id), "sessions"), { recursive: true });
  for (const t of taskIds) mkdirSync(taskDir(id, t), { recursive: true });
}

export function writeMeta(meta: JobMeta): void {
  meta.updatedAt = new Date().toISOString();
  mkdirSync(jobDir(meta.id), { recursive: true });
  atomicWrite(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

export function readMeta(id: string): JobMeta {
  const p = metaPath(id);
  if (!existsSync(p)) throw new Error(`unknown job: ${id}`);
  return JSON.parse(readFileSync(p, "utf8")) as JobMeta;
}

export function briefsPath(id: string): string {
  return join(jobDir(id), "briefs.json");
}

export function writeBriefs(id: string, briefs: Brief[]): void {
  mkdirSync(jobDir(id), { recursive: true });
  atomicWrite(briefsPath(id), JSON.stringify(briefs, null, 2));
}

export function readBriefs(id: string): Brief[] {
  return JSON.parse(readFileSync(briefsPath(id), "utf8")) as Brief[];
}

export function writeResult(id: string, rollup: JobRollup): void {
  atomicWrite(resultPath(id), JSON.stringify(rollup, null, 2));
}

export function readResult(id: string): JobRollup | null {
  const p = resultPath(id);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as JobRollup) : null;
}

export function writeTaskResult(id: string, taskId: string, data: unknown): void {
  atomicWrite(taskResultPath(id, taskId), JSON.stringify(data, null, 2));
}

export function readTaskResult(id: string, taskId: string): unknown | null {
  const p = taskResultPath(id, taskId);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function clearAbort(id: string): void {
  if (existsSync(abortFlagPath(id))) rmSync(abortFlagPath(id));
}

export function jobExists(id: string): boolean {
  return existsSync(metaPath(id));
}

export function listJobIds(): string[] {
  const dir = jobsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(metaPath(name)))
    .sort((a, b) => mtime(metaPath(b)) - mtime(metaPath(a)));
}

export function requestAbort(id: string): void {
  writeFileSync(abortFlagPath(id), new Date().toISOString());
}

export function abortRequested(id: string): boolean {
  return existsSync(abortFlagPath(id));
}

/** Prune job dirs older than `maxAgeDays`, keeping at most `keep` most-recent. */
export function pruneJobs(opts: { keep?: number; maxAgeDays?: number } = {}): string[] {
  const keep = opts.keep ?? 50;
  const maxAgeMs = (opts.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  const ids = listJobIds();
  const now = Date.now();
  const removed: string[] = [];
  ids.forEach((id, index) => {
    const age = now - mtime(metaPath(id));
    if (index >= keep || age > maxAgeMs) {
      rmSync(jobDir(id), { recursive: true, force: true });
      removed.push(id);
    }
  });
  return removed;
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  // rename is atomic on the same filesystem; avoids torn reads by `wait`/`status`.
  renameSync(tmp, path);
}
