// Build the compact, bounded TaskResult the host reads — from mechanical
// extraction (events) + pi's self-report block, cross-checked against the
// objective verify gate.

import type { Brief, TaskResult, VerifyResult, JobRollup, TaskStatus, FileChange } from "./types.js";
import type { Extracted } from "./events.js";
import { SENTINEL } from "./brief.js";
import { eventsPath, sessionPath, taskResultPath } from "./store.js";

const SUMMARY_CAP = 800;

interface SelfReport {
  summary?: string;
  acceptanceMet?: boolean | null;
  blockers: string[];
}

export function parseSelfReport(finalText: string): SelfReport {
  const fence = new RegExp("```" + SENTINEL + "\\s*\\n([\\s\\S]*?)```", "i");
  const m = fence.exec(finalText);
  if (m) {
    try {
      const obj = JSON.parse(m[1]!.trim()) as Record<string, unknown>;
      return {
        summary: typeof obj.summary === "string" ? obj.summary : undefined,
        acceptanceMet:
          typeof obj.acceptance_met === "boolean" ? (obj.acceptance_met as boolean) : null,
        blockers: cleanBlockers(obj.blockers),
      };
    } catch {
      // fall through to text fallback
    }
  }
  // No structured block: use the final assistant text minus any fence remnants.
  const text = finalText.replace(/```[\s\S]*?```/g, "").trim();
  return { summary: text || undefined, acceptanceMet: null, blockers: [] };
}

function cleanBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((b): b is string => typeof b === "string")
    .map((b) => b.trim())
    .filter((b) => b && !/^<.*>$/.test(b) && b.toLowerCase() !== "none" && b.toLowerCase() !== "empty");
}

function truncate(s: string, cap = SUMMARY_CAP): string {
  return s.length > cap ? s.slice(0, cap - 1) + "…" : s;
}

export function buildTaskResult(args: {
  jobId: string;
  brief: Brief;
  extracted: Extracted;
  filesChanged: FileChange[];
  verify: VerifyResult;
  fixIterations: number;
  aborted: boolean;
}): TaskResult {
  const { jobId, brief, extracted, filesChanged, verify, fixIterations, aborted } = args;
  const report = parseSelfReport(extracted.finalText);

  let status: TaskStatus;
  if (aborted) {
    status = "aborted";
  } else if (!verify.ran) {
    // Read-only / no-gate delegation: completion is the bar.
    status = extracted.completed ? "success" : "failed";
  } else if (verify.passed) {
    status = "success";
  } else if (filesChanged.length > 0 || extracted.completed) {
    status = "partial";
  } else {
    status = "failed";
  }

  const summary =
    report.summary?.trim() ||
    (status === "success"
      ? verify.ran
        ? "Completed; verification passed."
        : "Completed."
      : "No summary reported by the delegate.");

  return {
    taskId: brief.id,
    status,
    summary: truncate(summary),
    filesChanged,
    verification: verify,
    acceptance: {
      met: verify.ran ? verify.passed : report.acceptanceMet ?? null,
      ...(report.acceptanceMet === false && verify.passed
        ? { notes: "delegate self-reported acceptance not met despite green verify" }
        : {}),
    },
    blockers: report.blockers,
    fixIterations,
    cost: extracted.cost,
    ...(extracted.provider ? { provider: extracted.provider } : {}),
    ...(extracted.model ? { model: extracted.model } : {}),
    pointers: {
      jobId,
      eventsPath: eventsPath(jobId, brief.id),
      sessionPath: sessionPath(jobId, brief.id),
      resultPath: taskResultPath(jobId, brief.id),
    },
  };
}

export function rollup(
  jobId: string,
  cwd: string,
  status: JobRollup["status"],
  tasks: TaskResult[],
  piVersion: string | null = null,
): JobRollup {
  const succeeded = tasks.filter((t) => t.status === "success").length;
  const partial = tasks.filter((t) => t.status === "partial").length;
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "aborted").length;
  const cost = tasks.reduce((sum, t) => sum + t.cost.total, 0);

  let overall: JobRollup["overall"];
  if (tasks.length === 0) overall = "failed";
  else if (succeeded === tasks.length) overall = "success";
  else if (succeeded > 0 || partial > 0) overall = "partial";
  else overall = "failed"; // only failed / aborted tasks

  return {
    jobId,
    status,
    overall,
    cwd,
    engine: { piVersion },
    tasks,
    totals: { tasks: tasks.length, succeeded, partial, failed, cost },
  };
}
