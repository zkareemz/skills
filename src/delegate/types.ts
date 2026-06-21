// Shared types for the pi-delegate engine.

export type TaskStatus =
  | "queued"
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "aborted";

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "aborted"
  | "error";

/** A single self-contained unit of work handed to one pi delegate. */
export interface Brief {
  id: string;
  objective: string;
  acceptance: string;
  /** Shell commands the engine runs to gate success. Required, non-empty. */
  verify: string[];
  context?: string;
  paths?: string;
  constraints?: string;
  outOfScope?: string;
  /** Other task ids this one depends on (only used for --parallel grouping). */
  dependsOn?: string[];
}

/** Per-delegation knobs, passed through to pi where applicable. */
export interface JobOptions {
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string;
  parallel: boolean;
  /** Max concurrent delegates when parallel (worktree pool size). */
  maxParallel: number;
  failFast: boolean;
  /** Read-only delegation: pi gets read tools only and verify is optional. */
  readOnly: boolean;
  /** Whole-job wall-clock budget in milliseconds. */
  timeoutMs: number;
  /** Max fix-loop iterations after a red verify. */
  maxFixIterations: number;
}

export interface PiCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface FileChange {
  path: string;
  kind: "create" | "modify" | "delete" | "rename";
}

export interface VerifyCommandResult {
  cmd: string;
  exitCode: number;
  outputTail: string;
}

export interface VerifyResult {
  passed: boolean;
  ran: boolean;
  results: VerifyCommandResult[];
}

/** Compact, bounded result for one delegated task — what the host reads. */
export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  summary: string;
  filesChanged: FileChange[];
  verification: VerifyResult;
  acceptance: { met: boolean | null; notes?: string };
  blockers: string[];
  fixIterations: number;
  cost: PiCost;
  provider?: string;
  model?: string;
  pointers: {
    jobId: string;
    eventsPath: string;
    sessionPath: string;
    resultPath: string;
  };
}

/** Overall rollup for a job (one or many tasks). */
export interface JobRollup {
  jobId: string;
  status: JobStatus;
  overall: "success" | "partial" | "failed";
  cwd: string;
  engine: { piVersion: string | null };
  tasks: TaskResult[];
  totals: {
    tasks: number;
    succeeded: number;
    partial: number;
    failed: number;
    cost: number;
  };
}

export interface TaskMeta {
  id: string;
  status: TaskStatus;
  dependsOn: string[];
}

export interface JobMeta {
  id: string;
  version: 1;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  status: JobStatus;
  options: JobOptions;
  piVersion: string | null;
  supervisorPid: number | null;
  tasks: TaskMeta[];
  /** Set when the job reaches a terminal state. */
  finishedAt?: string;
  error?: string;
}
