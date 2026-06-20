// Run a brief's verify commands as the objective success gate.

import { spawn } from "node:child_process";
import type { VerifyCommandResult, VerifyResult } from "./types.js";

const TAIL_BYTES = 2000;

function tail(s: string): string {
  return s.length > TAIL_BYTES ? s.slice(s.length - TAIL_BYTES) : s;
}

function runOne(cmd: string, cwd: string, signal?: AbortSignal): Promise<VerifyCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > TAIL_BYTES * 2) out = tail(out);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      resolve({ cmd, exitCode: 127, outputTail: tail(out + `\n[spawn error] ${err.message}`) });
    });
    child.on("close", (code) => {
      resolve({ cmd, exitCode: code ?? -1, outputTail: tail(out).trim() });
    });
  });
}

/**
 * Run verify commands in order, stopping at the first failure (its output is the
 * actionable signal for the fix-loop). Returns passed=true only if all ran green.
 */
export async function runVerify(
  cwd: string,
  cmds: string[],
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const results: VerifyCommandResult[] = [];
  for (const cmd of cmds) {
    const r = await runOne(cmd, cwd, signal);
    results.push(r);
    if (r.exitCode !== 0) return { passed: false, ran: true, results };
  }
  return { passed: results.length > 0, ran: results.length > 0, results };
}

/** Concatenated tail of failing command output, for the fix-loop prompt. */
export function failingTail(v: VerifyResult): string {
  return v.results
    .filter((r) => r.exitCode !== 0)
    .map((r) => `$ ${r.cmd}\n(exit ${r.exitCode})\n${r.outputTail}`)
    .join("\n\n")
    .slice(-TAIL_BYTES);
}
