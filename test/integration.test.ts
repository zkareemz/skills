import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ROOT = resolve(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const MOCK = join(ROOT, "test", "fixtures", "mock-pi.mjs");

const cleanups: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  while (cleanups.length) {
    const d = cleanups.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

beforeAll(() => {
  execFileSync("npx", ["tsup"], { cwd: ROOT, stdio: "ignore" });
});

interface Env {
  work: string;
  home: string;
  extra?: Record<string, string>;
}
function makeEnv(extra?: Record<string, string>): Env {
  return { work: tmp("pidg-work-"), home: tmp("pidg-home-"), extra };
}
function run(args: string[], env: Env): any {
  const out = execFileSync("node", [CLI, "delegate", ...args], {
    cwd: env.work,
    encoding: "utf8",
    env: {
      ...process.env,
      PIDELEGATE_PI_BIN: MOCK,
      PIDELEGATE_HOME: env.home,
      ...env.extra,
    },
  });
  return JSON.parse(out);
}

function gitInit(dir: string): void {
  const opts = { cwd: dir, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opts);
  execFileSync("git", ["config", "user.email", "t@t"], opts);
  execFileSync("git", ["config", "user.name", "t"], opts);
  writeFileSync(join(dir, "README.md"), "seed\n");
  execFileSync("git", ["add", "-A"], opts);
  execFileSync("git", ["commit", "-qm", "seed"], opts);
}

function brief(dir: string, name: string, verifyFile: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      "---",
      `verify: ["test -f ${verifyFile}"]`,
      "---",
      "## Objective",
      `Create ${verifyFile}.`,
      "## Acceptance criteria",
      `${verifyFile} exists.`,
    ].join("\n"),
  );
  return p;
}

describe("delegate run (integration)", () => {
  it("happy path: success, file created, no fix iterations", () => {
    const env = makeEnv();
    brief(env.work, "brief.md", "hello.txt");
    const res = run(["run", "brief.md", "--wait", "--budget", "30s"], env);
    expect(res.state).toBe("done");
    expect(res.result.overall).toBe("success");
    expect(existsSync(join(env.work, "hello.txt"))).toBe(true);
    const t = res.result.tasks[0];
    expect(t.status).toBe("success");
    expect(t.fixIterations).toBe(0);
    expect(t.filesChanged).toEqual([{ path: "hello.txt", kind: "create" }]);
  });

  it("fix-loop: recovers after an initial red verify", () => {
    const env = makeEnv({ MOCK_PI_FAIL_TIMES: "1" });
    brief(env.work, "brief.md", "hello.txt");
    const res = run(["run", "brief.md", "--wait", "--budget", "30s", "--max-fix", "2"], env);
    expect(res.result.overall).toBe("success");
    expect(res.result.tasks[0].fixIterations).toBeGreaterThanOrEqual(1);
  });

  it("partial: returns partial after exhausting the fix budget", () => {
    const env = makeEnv({ MOCK_PI_FAIL_TIMES: "99" });
    brief(env.work, "brief.md", "hello.txt");
    const res = run(["run", "brief.md", "--wait", "--budget", "30s", "--max-fix", "1"], env);
    expect(res.result.overall).toBe("partial");
    const t = res.result.tasks[0];
    expect(t.status).toBe("partial");
    expect(t.verification.passed).toBe(false);
    expect(t.fixIterations).toBe(1);
    expect(existsSync(join(env.work, "hello.txt"))).toBe(false);
  });

  it("multi-task: runs an ordered list and rolls up", () => {
    const env = makeEnv();
    const tasksDir = join(env.work, "tasks");
    mkdirSync(tasksDir);
    brief(tasksDir, "01-a.md", "a.txt");
    brief(tasksDir, "02-b.md", "b.txt");
    const res = run(["run", "--tasks", tasksDir, "--wait", "--budget", "30s"], env);
    expect(res.result.overall).toBe("success");
    expect(res.result.totals).toMatchObject({ tasks: 2, succeeded: 2 });
    expect(existsSync(join(env.work, "a.txt"))).toBe(true);
    expect(existsSync(join(env.work, "b.txt"))).toBe(true);
  });

  it("fail-fast: skips remaining tasks after a failure", () => {
    const env = makeEnv({ MOCK_PI_FAIL_TIMES: "99" });
    const tasksDir = join(env.work, "tasks");
    mkdirSync(tasksDir);
    brief(tasksDir, "01-a.md", "a.txt");
    brief(tasksDir, "02-b.md", "b.txt");
    const res = run(
      ["run", "--tasks", tasksDir, "--wait", "--budget", "30s", "--max-fix", "0", "--fail-fast"],
      env,
    );
    expect(res.result.overall).not.toBe("success");
    expect(res.result.tasks[1].status).toBe("aborted");
    expect(existsSync(join(env.work, "b.txt"))).toBe(false);
  });

  it("validation: rejects a brief missing required fields", () => {
    const env = makeEnv();
    writeFileSync(join(env.work, "bad.md"), "## Objective\nonly objective, no acceptance/verify");
    let threw = false;
    try {
      execFileSync("node", [CLI, "delegate", "run", "bad.md"], {
        cwd: env.work,
        encoding: "utf8",
        env: { ...process.env, PIDELEGATE_PI_BIN: MOCK, PIDELEGATE_HOME: env.home },
      });
    } catch (e: any) {
      threw = true;
      expect(JSON.parse(e.stdout).error).toMatch(/acceptance|verify/);
    }
    expect(threw).toBe(true);
  });

  it("parallel: runs delegates in worktrees and merges results back", () => {
    const env = makeEnv();
    gitInit(env.work);
    const tasksDir = join(env.work, "tasks");
    mkdirSync(tasksDir);
    brief(tasksDir, "01-a.md", "a.txt");
    brief(tasksDir, "02-b.md", "b.txt");
    const res = run(["run", "--tasks", tasksDir, "--parallel", "--wait", "--budget", "30s"], env);
    expect(res.result.overall).toBe("success");
    expect(res.result.totals).toMatchObject({ tasks: 2, succeeded: 2 });
    // Both branches merged into the real working tree.
    expect(existsSync(join(env.work, "a.txt"))).toBe(true);
    expect(existsSync(join(env.work, "b.txt"))).toBe(true);
  });

  it("parallel --max-parallel 1: still completes all tasks", () => {
    const env = makeEnv();
    gitInit(env.work);
    const tasksDir = join(env.work, "tasks");
    mkdirSync(tasksDir);
    brief(tasksDir, "01-a.md", "a.txt");
    brief(tasksDir, "02-b.md", "b.txt");
    const res = run(["run", "--tasks", tasksDir, "--parallel", "--max-parallel", "1", "--wait", "--budget", "30s"], env);
    expect(res.result.totals).toMatchObject({ tasks: 2, succeeded: 2 });
  });

  it("read-only: no verify required; runs and returns success without a gate", () => {
    const env = makeEnv();
    writeFileSync(
      join(env.work, "ro.md"),
      ["## Objective", "Investigate the repo.", "## Acceptance criteria", "Report findings."].join("\n"),
    );
    const res = run(["run", "ro.md", "--read-only", "--wait", "--budget", "30s"], env);
    expect(res.result.overall).toBe("success");
    expect(res.result.tasks[0].status).toBe("success");
    expect(res.result.tasks[0].verification.ran).toBe(false);
  });

  it("file detection: git porcelain catches a change with no tool event", () => {
    const env = makeEnv({ MOCK_PI_SIDE_FILE: "side.txt" });
    gitInit(env.work);
    brief(env.work, "brief.md", "hello.txt");
    const res = run(["run", "brief.md", "--wait", "--budget", "30s"], env);
    expect(res.result.overall).toBe("success");
    const paths = res.result.tasks[0].filesChanged.map((c: any) => c.path);
    expect(paths).toContain("hello.txt"); // tool event + git
    expect(paths).toContain("side.txt"); // git only — no tool event existed
  });

  it("liveness: a dead supervisor is reconciled to error", async () => {
    const env = makeEnv({ MOCK_PI_SLEEP_MS: "6000" });
    brief(env.work, "brief.md", "hello.txt");
    const id = run(["run", "brief.md"], env).job_id;

    let pid: number | null = null;
    for (let i = 0; i < 60; i++) {
      const meta = JSON.parse(readFileSync(join(env.home, "jobs", id, "meta.json"), "utf8"));
      if (meta.supervisorPid && meta.status === "running") {
        pid = meta.supervisorPid;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pid).toBeTruthy();
    process.kill(pid!, "SIGKILL");

    let final: any;
    for (let i = 0; i < 60; i++) {
      final = run(["status", id], env);
      if (final.status === "error") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(final.status).toBe("error");
  });

  it("abort: a running job can be aborted and reports aborted", async () => {
    const env = makeEnv({ MOCK_PI_SLEEP_MS: "4000" });
    brief(env.work, "brief.md", "hello.txt");
    const started = run(["run", "brief.md"], env);
    const id = started.job_id;

    // Wait until the supervisor marks it running, then abort.
    for (let i = 0; i < 50; i++) {
      const s = run(["status", id], env);
      if (s.status === "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    run(["abort", id], env);

    // Drain to terminal.
    let final: any;
    for (let i = 0; i < 100; i++) {
      final = run(["status", id], env);
      if (["aborted", "done", "error"].includes(final.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(final.status).toBe("aborted");
  });
});
