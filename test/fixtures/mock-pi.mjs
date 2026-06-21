#!/usr/bin/env node
// A stand-in for the `pi` binary used in tests. It speaks just enough of pi's
// `--mode json` event protocol for pidelegate, and actually mutates the repo so
// the verify gate is exercised for real.
//
// Env knobs:
//   MOCK_PI_FILE       file to create (default hello.txt)
//   MOCK_PI_CONTENT    file contents (default "hi")
//   MOCK_PI_FAIL_TIMES number of initial calls that should NOT create the file
//                      (simulates a delegate that needs fix-loop iterations)
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

// Preflight calls `pi --version`; respond without touching the filesystem.
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("mock-pi 0.0.0\n");
  process.exit(0);
}

const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 ? args[pIdx + 1] : "";
const cwd = process.cwd();
// Prefer the file named in the brief's verify (`test -f X`) so multi-task runs
// touch distinct files; fall back to MOCK_PI_FILE.
const verifyMatch = /test -f `?([^`\s]+)/.exec(prompt);
const file = verifyMatch ? verifyMatch[1] : process.env.MOCK_PI_FILE || "hello.txt";
const content = process.env.MOCK_PI_CONTENT || "hi";
const failTimes = Number(process.env.MOCK_PI_FAIL_TIMES || "0");
const sleepMs = Number(process.env.MOCK_PI_SLEEP_MS || "0");
if (sleepMs > 0) {
  const until = Date.now() + sleepMs;
  while (Date.now() < until) {
    /* busy-wait so SIGTERM during a "long" run is observable */
  }
}

// Persist a call counter in cwd so successive (fix-loop) invocations advance.
const counterPath = join(cwd, ".mock-pi-count");
const n = (existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0) + 1;
writeFileSync(counterPath, String(n));
const shouldCreate = n > failTimes;

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

emit({ type: "session", version: 3, id: "mock-" + n, timestamp: new Date().toISOString(), cwd });
emit({ type: "agent_start" });
emit({ type: "turn_start" });

if (shouldCreate) {
  writeFileSync(join(cwd, file), content);
  emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: file, content } });
  emit({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "write",
    result: { content: [{ type: "text", text: `wrote ${file}` }] },
    isError: false,
  });
  // A change made WITHOUT a tool event (simulates a bash-driven edit) — only
  // git porcelain can see this, not the event stream.
  const sideFile = process.env.MOCK_PI_SIDE_FILE;
  if (sideFile) writeFileSync(join(cwd, sideFile), "side");
}

const report =
  "```pidelegate-report\n" +
  JSON.stringify({
    summary: shouldCreate ? `Created ${file}.` : `Attempt ${n}: not done yet.`,
    acceptance_met: shouldCreate,
    blockers: shouldCreate ? [] : ["could not finish this attempt"],
  }) +
  "\n```";

const msg = {
  role: "assistant",
  content: [{ type: "text", text: report }],
  api: "mock",
  provider: "mock",
  model: "mock-1",
  usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00012 } },
  stopReason: "stop",
};

emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: prompt.slice(0, 40) }] } });
emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt.slice(0, 40) }] } });
emit({ type: "message_start", message: msg });
emit({ type: "message_end", message: msg });
emit({ type: "turn_end" });
emit({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: prompt.slice(0, 40) }] }, msg], willRetry: false });
