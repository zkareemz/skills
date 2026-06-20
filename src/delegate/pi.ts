// Spawn pi as a subprocess in `--mode json` and stream its events to a file.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JobOptions } from "./types.js";

/** The pi binary to invoke (overridable for tests / pinned installs). */
export function piBin(): string {
  return process.env.PIDELEGATE_PI_BIN ?? "pi";
}

export interface PreflightResult {
  ok: boolean;
  bin: string;
  version?: string;
  error?: string;
}

/** Verify pi is reachable. Auth is left to pi (surfaced as run errors). */
export function preflight(): PreflightResult {
  const bin = piBin();
  try {
    const version = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { ok: true, bin, version };
  } catch (e) {
    return {
      ok: false,
      bin,
      error:
        `pi binary "${bin}" not found or not runnable (${(e as Error).message}). ` +
        `Install pi and ensure it is on PATH, or set PIDELEGATE_PI_BIN.`,
    };
  }
}

export interface RunPiArgs {
  cwd: string;
  prompt: string;
  sessionDir: string;
  sessionId: string;
  eventsFile: string;
  options: JobOptions;
  signal?: AbortSignal;
  /** Called for each parsed event line (best-effort, for live progress). */
  onEvent?: (event: Record<string, any>) => void;
}

export interface RunPiResult {
  exitCode: number | null;
  signalled: boolean;
}

function buildArgs(a: RunPiArgs): string[] {
  const args = ["--mode", "json", "--session-dir", a.sessionDir, "--session-id", a.sessionId];
  if (a.options.model) args.push("--model", a.options.model);
  if (a.options.provider) args.push("--provider", a.options.provider);
  if (a.options.thinking) args.push("--thinking", a.options.thinking);
  if (a.options.tools) args.push("--tools", a.options.tools);
  args.push("-p", a.prompt);
  return args;
}

/** Run pi once; appends its JSONL events to `eventsFile`. Resolves on exit. */
export function runPi(a: RunPiArgs): Promise<RunPiResult> {
  mkdirSync(dirname(a.eventsFile), { recursive: true });
  const out = createWriteStream(a.eventsFile, { flags: "a" });

  return new Promise((resolve, reject) => {
    const child = spawn(piBin(), buildArgs(a), {
      cwd: a.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: a.signal,
    });

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      out.write(s);
      if (!a.onEvent) return;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            a.onEvent(JSON.parse(line));
          } catch {
            /* ignore partial/non-JSON */
          }
        }
      }
    });

    // Surface stderr into the events file as a diagnostic trailer.
    child.stderr.on("data", (chunk: Buffer) => {
      out.write(
        JSON.stringify({ type: "pi_stderr", text: chunk.toString() }) + "\n",
      );
    });

    child.on("error", (err) => {
      out.end();
      if ((err as NodeJS.ErrnoException).name === "AbortError") {
        resolve({ exitCode: null, signalled: true });
      } else {
        reject(err);
      }
    });
    child.on("close", (code, sig) => {
      out.end();
      resolve({ exitCode: code, signalled: sig !== null });
    });
  });
}
