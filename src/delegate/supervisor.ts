// Detached worker: runs a job's task queue (sequential in-place by default, or
// parallel via git worktrees), drives the verify-gated fix-loop, honors
// abort/timeout, and writes per-task + rollup results.

import { renderPrompt, renderFixPrompt } from "./brief.js";
import { runPi } from "./pi.js";
import { runVerify, failingTail } from "./verify.js";
import { readEvents, extract } from "./events.js";
import { buildTaskResult, rollup } from "./report.js";
import {
  isGitRepo,
  createWorktree,
  commitAll,
  mergeBranch,
  removeWorktree,
  type Worktree,
} from "./worktree.js";
import {
  readMeta,
  writeMeta,
  readBriefs,
  writeResult,
  writeTaskResult,
  readTaskResult,
  eventsPath,
  sessionsDir,
  sessionPath,
  taskResultPath,
  abortRequested,
  ensureJobDirs,
} from "./store.js";
import type { Brief, JobMeta, TaskResult, TaskStatus } from "./types.js";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/** Render → run pi → verify → bounded fix-loop, executing in `execCwd`. */
async function runTask(
  meta: JobMeta,
  brief: Brief,
  controller: AbortController,
  execCwd: string,
): Promise<TaskResult> {
  const jobId = meta.id;
  const events = eventsPath(jobId, brief.id);
  const opts = meta.options;

  log(`task ${brief.id}: starting (verify: ${brief.verify.join(", ")})`);
  await runPi({
    cwd: execCwd,
    prompt: renderPrompt(brief),
    sessionDir: sessionsDir(jobId),
    sessionId: brief.id,
    eventsFile: events,
    options: opts,
    signal: controller.signal,
  });

  let fixIterations = 0;
  let verify = await runVerify(execCwd, brief.verify, controller.signal);
  log(`task ${brief.id}: verify ${verify.passed ? "passed" : "FAILED"}`);

  while (!verify.passed && fixIterations < opts.maxFixIterations && !controller.signal.aborted) {
    fixIterations += 1;
    log(`task ${brief.id}: fix iteration ${fixIterations}/${opts.maxFixIterations}`);
    await runPi({
      cwd: execCwd,
      prompt: renderFixPrompt(brief, failingTail(verify)),
      sessionDir: sessionsDir(jobId),
      sessionId: brief.id,
      eventsFile: events,
      options: opts,
      signal: controller.signal,
    });
    verify = await runVerify(execCwd, brief.verify, controller.signal);
    log(`task ${brief.id}: verify ${verify.passed ? "passed" : "still failing"}`);
  }

  const result = buildTaskResult({
    jobId,
    brief,
    extracted: extract(readEvents(events)),
    verify,
    fixIterations,
    aborted: controller.signal.aborted,
  });
  writeTaskResult(jobId, brief.id, result);
  return result;
}

/** Run runTask with error handling, always producing (and persisting) a result. */
async function executeTask(
  meta: JobMeta,
  brief: Brief,
  controller: AbortController,
  execCwd: string,
): Promise<TaskResult> {
  try {
    return await runTask(meta, brief, controller, execCwd);
  } catch (err) {
    log(`task ${brief.id}: error ${(err as Error).message}`);
    const result: TaskResult = {
      ...abortedResult(meta.id, brief),
      status: "failed",
      summary: `Delegate errored: ${(err as Error).message}`,
    };
    writeTaskResult(meta.id, brief.id, result);
    return result;
  }
}

// ---- sequential (default, in-place) ---------------------------------------

async function runSequential(
  meta: JobMeta,
  briefs: Brief[],
  controller: AbortController,
  results: TaskResult[],
): Promise<void> {
  for (const brief of briefs) {
    // Resume idempotency: a task already marked success keeps its result.
    const existing = meta.tasks.find((t) => t.id === brief.id);
    if (existing?.status === "success") {
      const prior = readTaskResult(meta.id, brief.id) as TaskResult | null;
      if (prior) {
        log(`task ${brief.id}: already succeeded, skipping`);
        results.push(prior);
        continue;
      }
    }

    setTaskStatus(meta, brief.id, "running");
    writeMeta(meta);

    if (controller.signal.aborted) {
      results.push(persistAborted(meta, brief));
      continue;
    }

    const result = await executeTask(meta, brief, controller, meta.cwd);
    results.push(result);
    setTaskStatus(meta, brief.id, result.status);
    writeMeta(meta);

    if (meta.options.failFast && (result.status === "failed" || result.status === "partial")) {
      log(`fail-fast: stopping after ${brief.id} (${result.status})`);
      for (const rest of briefs.slice(briefs.indexOf(brief) + 1)) {
        results.push(persistAborted(meta, rest));
      }
      break;
    }
  }
}

// ---- parallel (opt-in, worktree per task) ---------------------------------

async function runParallel(
  meta: JobMeta,
  briefs: Brief[],
  controller: AbortController,
  results: TaskResult[],
): Promise<void> {
  if (!isGitRepo(meta.cwd)) {
    throw new Error("--parallel requires the working directory to be a git repository");
  }
  log(`parallel: ${briefs.length} delegates, one git worktree each`);
  for (const b of briefs) setTaskStatus(meta, b.id, "running");
  writeMeta(meta);

  const worktrees = new Map<string, Worktree>();
  for (const b of briefs) worktrees.set(b.id, createWorktree(meta.cwd, meta.id, b.id));

  const settled = await Promise.allSettled(
    briefs.map(async (b) => {
      const wt = worktrees.get(b.id)!;
      const result = await executeTask(meta, b, controller, wt.dir);
      const committed =
        !controller.signal.aborted &&
        result.status !== "aborted" &&
        commitAll(wt.dir, `pidelegate: ${b.id}`);
      return { brief: b, result, committed, wt };
    }),
  );

  // Merge successful, committed branches back into the repo, one at a time.
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      log(`parallel: a delegate rejected: ${String(s.reason)}`);
      continue;
    }
    const { brief, result, committed, wt } = s.value;
    let finalResult = result;
    if (result.status === "success" && committed) {
      const merge = mergeBranch(meta.cwd, wt.branch);
      if (merge.conflict) {
        finalResult = {
          ...result,
          status: "partial",
          blockers: [...result.blockers, `merge conflict on ${wt.branch}: ${merge.message ?? ""}`],
        };
        log(`parallel: ${brief.id} merge conflict`);
      } else {
        log(`parallel: ${brief.id} merged`);
      }
    }
    writeTaskResult(meta.id, brief.id, finalResult);
    setTaskStatus(meta, brief.id, finalResult.status);
    results.push(finalResult);
  }

  for (const wt of worktrees.values()) removeWorktree(meta.cwd, wt);
  writeMeta(meta);
}

// ---- top-level supervisor --------------------------------------------------

export async function runSupervisor(jobId: string): Promise<void> {
  const meta = readMeta(jobId);
  const briefs = readBriefs(jobId);
  ensureJobDirs(jobId, briefs.map((b) => b.id));

  meta.status = "running";
  meta.supervisorPid = process.pid;
  writeMeta(meta);

  const controller = new AbortController();
  let abortedReason: string | null = null;

  const poller = setInterval(() => {
    if (abortRequested(jobId) && !controller.signal.aborted) {
      abortedReason = "abort requested";
      controller.abort();
    }
  }, 1000);

  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      abortedReason = `timeout after ${meta.options.timeoutMs}ms`;
      controller.abort();
    }
  }, meta.options.timeoutMs);

  const onSignal = () => {
    abortedReason = "received termination signal";
    controller.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const results: TaskResult[] = [];
  try {
    if (meta.options.parallel) {
      await runParallel(meta, briefs, controller, results);
    } else {
      await runSequential(meta, briefs, controller, results);
    }

    const jobStatus = controller.signal.aborted ? "aborted" : "done";
    meta.status = jobStatus;
    meta.finishedAt = new Date().toISOString();
    if (abortedReason) meta.error = abortedReason;
    writeMeta(meta);
    writeResult(jobId, rollup(jobId, meta.cwd, jobStatus, results));
    log(`job ${jobId}: ${jobStatus} (${results.length} tasks)`);
  } catch (err) {
    meta.status = "error";
    meta.error = (err as Error).message;
    meta.finishedAt = new Date().toISOString();
    writeMeta(meta);
    writeResult(jobId, rollup(jobId, meta.cwd, "error", results));
    log(`job ${jobId}: error ${(err as Error).message}`);
  } finally {
    clearInterval(poller);
    clearTimeout(timeout);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

function setTaskStatus(meta: JobMeta, taskId: string, status: TaskStatus): void {
  const t = meta.tasks.find((x) => x.id === taskId);
  if (t) t.status = status;
}

function persistAborted(meta: JobMeta, brief: Brief): TaskResult {
  const r = abortedResult(meta.id, brief);
  writeTaskResult(meta.id, brief.id, r);
  setTaskStatus(meta, brief.id, "aborted");
  writeMeta(meta);
  return r;
}

function abortedResult(jobId: string, brief: Brief): TaskResult {
  return {
    taskId: brief.id,
    status: "aborted",
    summary: "Task did not run (job aborted or fail-fast).",
    filesChanged: [],
    verification: { passed: false, ran: false, results: [] },
    acceptance: { met: null },
    blockers: [],
    fixIterations: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    pointers: {
      jobId,
      eventsPath: eventsPath(jobId, brief.id),
      sessionPath: sessionPath(jobId, brief.id),
      resultPath: taskResultPath(jobId, brief.id),
    },
  };
}
