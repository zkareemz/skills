// pidelegate CLI subcommands. Machine-facing output is JSON; `logs` is human text.

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { resolve } from "node:path";
import { loadBriefs, dedupeIds } from "./brief.js";
import { preflight } from "./pi.js";
import { runSupervisor } from "./supervisor.js";
import { readEvents } from "./events.js";
import {
  newJobId,
  readMeta,
  writeMeta,
  writeBriefs,
  ensureJobDirs,
  jobExists,
  listJobIds,
  readResult,
  requestAbort,
  clearAbort,
  supervisorLogPath,
  eventsPath,
} from "./store.js";
import { parseDuration, printJson, fail, sleep, fmtCost } from "./util.js";
import type { Brief, JobMeta, JobOptions, JobStatus } from "./types.js";

const TERMINAL: JobStatus[] = ["done", "aborted", "error"];
const isTerminal = (s: JobStatus) => TERMINAL.includes(s);

function progressOf(meta: JobMeta) {
  const byStatus: Record<string, number> = {};
  for (const t of meta.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const running = meta.tasks.find((t) => t.status === "running")?.id ?? null;
  return { tasksTotal: meta.tasks.length, running, byStatus, status: meta.status };
}

// ---- run -------------------------------------------------------------------

export async function cmdRun(argv: string[], entry: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tasks: { type: "string" },
      model: { type: "string" },
      provider: { type: "string" },
      thinking: { type: "string" },
      tools: { type: "string" },
      parallel: { type: "boolean", default: false },
      "fail-fast": { type: "boolean", default: false },
      timeout: { type: "string" },
      "max-fix": { type: "string" },
      cwd: { type: "string" },
      wait: { type: "boolean", default: false },
      budget: { type: "string" },
    },
  });

  const pf = preflight();
  if (!pf.ok) fail(pf.error!);

  const input = values.tasks ?? positionals[0];
  if (!input) fail("provide a brief file (positional) or --tasks <file|dir>");

  let briefs: Brief[];
  try {
    briefs = dedupeIds(loadBriefs(resolve(input)));
  } catch (e) {
    return fail((e as Error).message);
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  const options: JobOptions = {
    ...(values.model ? { model: values.model } : {}),
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.thinking ? { thinking: values.thinking } : {}),
    ...(values.tools ? { tools: values.tools } : {}),
    parallel: values.parallel ?? false,
    failFast: values["fail-fast"] ?? false,
    timeoutMs: parseDuration(values.timeout, 30 * 60_000),
    maxFixIterations: values["max-fix"] ? Number(values["max-fix"]) : 2,
  };

  const id = newJobId();
  const now = new Date().toISOString();
  const meta: JobMeta = {
    id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    cwd,
    status: "queued",
    options,
    supervisorPid: null,
    tasks: briefs.map((b) => ({ id: b.id, status: "queued", dependsOn: b.dependsOn ?? [] })),
  };
  ensureJobDirs(id, briefs.map((b) => b.id));
  writeBriefs(id, briefs);
  writeMeta(meta);

  spawnSupervisor(id, entry, cwd);

  if (values.wait) {
    await waitLoop(id, parseDuration(values.budget, 8 * 60_000));
    return;
  }
  printJson({
    ok: true,
    job_id: id,
    tasks: briefs.map((b) => b.id),
    cwd,
    parallel: options.parallel,
    message: `Started. Poll with: npx -y @zkareemz/skills delegate wait ${id}`,
  });
}

function spawnSupervisor(id: string, entry: string, cwd: string): void {
  const logFd = openSync(supervisorLogPath(id), "a");
  const child = spawn(process.execPath, [entry, "delegate", "__supervise", id], {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

// ---- wait ------------------------------------------------------------------

export async function cmdWait(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { budget: { type: "string" }, interval: { type: "string" } },
  });
  const id = positionals[0];
  if (!id || !jobExists(id)) fail(`unknown job: ${id ?? "(none)"}`);
  await waitLoop(id!, parseDuration(values.budget, 8 * 60_000), parseDuration(values.interval, 1000));
}

async function waitLoop(id: string, budgetMs: number, intervalMs = 1000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const meta = readMeta(id);
    if (isTerminal(meta.status)) {
      printJson({ ok: true, state: "done", job_id: id, result: readResult(id) ?? null });
      return;
    }
    if (Date.now() >= deadline) {
      printJson({
        ok: true,
        state: "running",
        job_id: id,
        progress: progressOf(meta),
        message: `Still running; call wait again to keep polling.`,
      });
      return;
    }
    await sleep(intervalMs);
  }
}

// ---- status / result -------------------------------------------------------

export function cmdStatus(argv: string[]): void {
  const id = argv[0];
  if (!id || !jobExists(id)) fail(`unknown job: ${id ?? "(none)"}`);
  const meta = readMeta(id!);
  printJson({
    ok: true,
    job_id: id,
    status: meta.status,
    progress: progressOf(meta),
    createdAt: meta.createdAt,
    finishedAt: meta.finishedAt ?? null,
    error: meta.error ?? null,
    hasResult: readResult(id!) != null,
  });
}

export function cmdResult(argv: string[]): void {
  const id = argv[0];
  if (!id || !jobExists(id)) fail(`unknown job: ${id ?? "(none)"}`);
  const result = readResult(id!);
  if (!result) fail(`no result yet for job ${id} (still running?)`);
  printJson({ ok: true, result });
}

// ---- list ------------------------------------------------------------------

export function cmdList(): void {
  const jobs = listJobIds().map((id) => {
    const meta = readMeta(id);
    return {
      job_id: id,
      status: meta.status,
      tasks: meta.tasks.length,
      createdAt: meta.createdAt,
      cwd: meta.cwd,
    };
  });
  printJson({ ok: true, jobs });
}

// ---- abort -----------------------------------------------------------------

export function cmdAbort(argv: string[]): void {
  const id = argv[0];
  if (!id || !jobExists(id)) fail(`unknown job: ${id ?? "(none)"}`);
  const meta = readMeta(id!);
  if (isTerminal(meta.status)) {
    printJson({ ok: true, job_id: id, status: meta.status, message: "already finished" });
    return;
  }
  requestAbort(id!);
  if (meta.supervisorPid) {
    try {
      process.kill(meta.supervisorPid, "SIGTERM");
    } catch {
      /* supervisor may have exited */
    }
  }
  printJson({ ok: true, job_id: id, message: "abort requested" });
}

// ---- resume ----------------------------------------------------------------

export function cmdResume(argv: string[], entry: string): void {
  const id = argv[0];
  if (!id || !jobExists(id)) fail(`unknown job: ${id ?? "(none)"}`);
  const meta = readMeta(id!);
  if (meta.status === "running") {
    printJson({ ok: true, job_id: id, message: "already running" });
    return;
  }
  clearAbort(id!);
  // Reset non-succeeded tasks so the supervisor re-runs them (success ones are skipped).
  for (const t of meta.tasks) if (t.status !== "success") t.status = "queued";
  meta.status = "queued";
  delete meta.finishedAt;
  delete meta.error;
  writeMeta(meta);
  spawnSupervisor(id!, entry, meta.cwd);
  printJson({ ok: true, job_id: id, message: `Resumed. Poll with: delegate wait ${id}` });
}

// ---- logs ------------------------------------------------------------------

export async function cmdLogs(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { follow: { type: "boolean", default: false } },
  });
  const id = positionals[0];
  if (!id || !jobExists(id)) fail(`unknown job: ${id ?? "(none)"}`);

  const render = () => {
    const meta = readMeta(id!);
    const lines: string[] = [];
    for (const t of meta.tasks) {
      lines.push(`\n=== task ${t.id} [${t.status}] ===`);
      for (const e of readEvents(eventsPath(id!, t.id))) {
        if (e.type === "tool_execution_start") {
          const detail = e.args?.path ?? e.args?.command ?? "";
          lines.push(`  → ${e.toolName} ${String(detail).slice(0, 100)}`);
        } else if (e.type === "message_end" && e.message?.role === "assistant") {
          const text = (e.message.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("")
            .trim();
          if (text) lines.push(`  ${text.replace(/\n/g, "\n  ")}`);
        } else if (e.type === "pi_stderr") {
          lines.push(`  [stderr] ${String(e.text).trim().slice(0, 200)}`);
        }
      }
    }
    return { meta, text: lines.join("\n") };
  };

  process.stdout.write(render().text + "\n");
  if (!values.follow) return;
  // Basic follow: re-render every 2s until terminal.
  let last = "";
  for (;;) {
    const { meta, text } = render();
    if (text !== last) {
      process.stdout.write(text.slice(last.length) + "\n");
      last = text;
    }
    if (isTerminal(meta.status)) return;
    await sleep(2000);
  }
}

// ---- plan (optional decomposition helper) ----------------------------------

export function cmdPlan(argv: string[]): void {
  const from = argv.find((a) => !a.startsWith("-")) ?? null;
  void from;
  fail(
    "delegate plan is not implemented yet. For now, the host should write the task " +
      "brief(s) directly and call `delegate run`.",
  );
}

// ---- hidden supervisor entry ----------------------------------------------

export async function cmdSupervise(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.error("__supervise requires a job id");
    process.exit(2);
  }
  await runSupervisor(id);
}

export function describeResultHuman(id: string): string {
  const r = readResult(id);
  if (!r) return `job ${id}: no result`;
  const head = `job ${id}: ${r.overall} (${r.totals.succeeded}/${r.totals.tasks} ok, cost ${fmtCost(r.totals.cost)})`;
  const tasks = r.tasks
    .map((t) => `  - ${t.taskId}: ${t.status} — ${t.summary}`)
    .join("\n");
  return `${head}\n${tasks}`;
}
