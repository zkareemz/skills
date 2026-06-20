import { describe, it, expect } from "vitest";
import { parseBrief, validateBrief, BriefError, renderPrompt, SENTINEL } from "../src/delegate/brief.js";
import { parseEventLines, extract } from "../src/delegate/events.js";
import { parseSelfReport, buildTaskResult, rollup } from "../src/delegate/report.js";
import { runVerify, failingTail } from "../src/delegate/verify.js";
import { parseDuration } from "../src/delegate/util.js";
import type { Brief } from "../src/delegate/types.js";

describe("brief parsing", () => {
  it("parses a valid brief with required fields", () => {
    const md = [
      "---",
      "id: add-auth",
      "verify:",
      "  - npm test",
      "  - npm run lint",
      "---",
      "## Objective",
      "Add JWT auth.",
      "",
      "## Acceptance criteria",
      "Login returns a token.",
      "",
      "## Context",
      "Greenfield service.",
    ].join("\n");
    const b = parseBrief(md, "fallback");
    expect(b.id).toBe("add-auth");
    expect(b.objective).toContain("JWT");
    expect(b.acceptance).toContain("token");
    expect(b.verify).toEqual(["npm test", "npm run lint"]);
    expect(b.context).toContain("Greenfield");
  });

  it("auto-ids from objective when none given", () => {
    const md = "---\nverify: [echo ok]\n---\n## Objective\nDo the thing\n## Acceptance criteria\nDone";
    const b = parseBrief(md, "fb");
    expect(b.id).toBe("fb");
  });

  it("throws on missing objective / acceptance / verify", () => {
    expect(() => parseBrief("## Objective\nx", "f")).toThrow(BriefError);
    expect(() => validateBrief({ id: "x", objective: "o", acceptance: "a", verify: [] })).toThrow(
      /verify/,
    );
    expect(() => validateBrief({ id: "x", objective: "o", verify: ["t"] })).toThrow(/acceptance/);
  });

  it("renders a prompt containing the report sentinel and sections", () => {
    const b: Brief = { id: "t", objective: "O", acceptance: "A", verify: ["test -f x"], dependsOn: [] };
    const p = renderPrompt(b);
    expect(p).toContain("## Objective");
    expect(p).toContain("## Acceptance criteria");
    expect(p).toContain("test -f x");
    expect(p).toContain(SENTINEL);
  });
});

describe("event extraction", () => {
  const stream = [
    JSON.stringify({ type: "session", id: "s", cwd: "/x" }),
    JSON.stringify({ type: "tool_execution_start", toolCallId: "a", toolName: "write", args: { path: "a.ts", content: "x" } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "a", toolName: "write", isError: false, result: {} }),
    JSON.stringify({ type: "tool_execution_start", toolCallId: "b", toolName: "edit", args: { path: "b.ts" } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "b", toolName: "edit", isError: true, result: {} }),
    JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
        },
      ],
      willRetry: false,
    }),
  ].join("\n");

  it("extracts files changed, ignoring failed tool calls", () => {
    const ex = extract(parseEventLines(stream));
    expect(ex.filesChanged).toEqual([{ path: "a.ts", kind: "create" }]); // b.ts failed
    expect(ex.completed).toBe(true);
    expect(ex.finalText).toBe("done");
  });

  it("tolerates partial trailing lines", () => {
    const ex = extract(parseEventLines(stream + "\n{partial"));
    expect(ex.completed).toBe(true);
  });
});

describe("self-report parsing", () => {
  it("parses a fenced report block", () => {
    const text = "blah\n```" + SENTINEL + "\n" + JSON.stringify({ summary: "did x", acceptance_met: true, blockers: [] }) + "\n```";
    const r = parseSelfReport(text);
    expect(r.summary).toBe("did x");
    expect(r.acceptanceMet).toBe(true);
  });

  it("filters placeholder blockers", () => {
    const text = "```" + SENTINEL + "\n" + JSON.stringify({ summary: "s", acceptance_met: false, blockers: ["<none>", "none", "real problem"] }) + "\n```";
    const r = parseSelfReport(text);
    expect(r.blockers).toEqual(["real problem"]);
  });

  it("falls back to plain text when no block", () => {
    const r = parseSelfReport("just some text");
    expect(r.summary).toBe("just some text");
    expect(r.acceptanceMet).toBeNull();
  });
});

describe("verify gate", () => {
  it("passes when all commands are green", async () => {
    const v = await runVerify(process.cwd(), ["true", "true"]);
    expect(v.passed).toBe(true);
  });
  it("fails fast and reports the failing command", async () => {
    const v = await runVerify(process.cwd(), ["echo boom && false", "true"]);
    expect(v.passed).toBe(false);
    expect(v.results).toHaveLength(1);
    expect(failingTail(v)).toContain("boom");
  });
});

describe("result + rollup", () => {
  const brief: Brief = { id: "t", objective: "O", acceptance: "A", verify: ["true"], dependsOn: [] };
  it("marks success when verify passed", () => {
    const r = buildTaskResult({
      jobId: "j",
      brief,
      extracted: { finalText: "ok", filesChanged: [{ path: "x", kind: "create" }], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, hadError: false, completed: true },
      verify: { passed: true, ran: true, results: [] },
      fixIterations: 0,
      aborted: false,
    });
    expect(r.status).toBe("success");
    expect(r.acceptance.met).toBe(true);
  });
  it("marks partial when verify failed but work was done", () => {
    const r = buildTaskResult({
      jobId: "j",
      brief,
      extracted: { finalText: "", filesChanged: [{ path: "x", kind: "create" }], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, hadError: false, completed: true },
      verify: { passed: false, ran: true, results: [] },
      fixIterations: 2,
      aborted: false,
    });
    expect(r.status).toBe("partial");
  });
  it("rolls up mixed task statuses to partial", () => {
    const ok = buildTaskResult({ jobId: "j", brief, extracted: { finalText: "", filesChanged: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 }, hadError: false, completed: true }, verify: { passed: true, ran: true, results: [] }, fixIterations: 0, aborted: false });
    const bad = buildTaskResult({ jobId: "j", brief: { ...brief, id: "u" }, extracted: { finalText: "", filesChanged: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, hadError: false, completed: false }, verify: { passed: false, ran: true, results: [] }, fixIterations: 2, aborted: false });
    const r = rollup("j", "/x", "done", [ok, bad]);
    expect(r.overall).toBe("partial");
    expect(r.totals.cost).toBeCloseTo(0.5);
  });
});

describe("parseDuration", () => {
  it("handles suffixes and bare ms", () => {
    expect(parseDuration("30m", 0)).toBe(1_800_000);
    expect(parseDuration("10s", 0)).toBe(10_000);
    expect(parseDuration("2h", 0)).toBe(7_200_000);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("1500", 0)).toBe(1500);
    expect(parseDuration(undefined, 42)).toBe(42);
  });
});
