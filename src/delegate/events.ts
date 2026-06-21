// Parse pi's `--mode json` event stream (JSONL) and extract the facts we report.
//
// Event shapes (confirmed against pi 0.79.8):
//   {"type":"session", id, cwd, ...}
//   {"type":"agent_start"|"turn_start"|"turn_end"}
//   {"type":"message_start"|"message_end","message":{role, content[], usage?}}
//   {"type":"message_update","assistantMessageEvent":{type:"text_delta"|...}}
//   {"type":"tool_execution_start","toolName","args":{path?,...},"toolCallId"}
//   {"type":"tool_execution_end","toolCallId","isError","result":{...}}
//   {"type":"agent_end","messages":[...],"willRetry"}

import { readFileSync, existsSync } from "node:fs";
import type { FileChange, PiCost } from "./types.js";

export type PiEvent = Record<string, any>;

/** Tools whose `args.path` represents a file mutation. */
const WRITE_TOOLS: Record<string, FileChange["kind"]> = {
  write: "create",
  edit: "modify",
  multiedit: "modify",
  multi_edit: "modify",
  apply_patch: "modify",
};

const ZERO_COST: PiCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

export function parseEventLines(text: string): PiEvent[] {
  const out: PiEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // tolerate partial trailing lines from a still-writing stream
    }
  }
  return out;
}

export function readEvents(path: string): PiEvent[] {
  if (!existsSync(path)) return [];
  return parseEventLines(readFileSync(path, "utf8"));
}

export interface Extracted {
  finalText: string;
  /** From parsed write/edit tool events; the engine prefers git porcelain when available. */
  toolFilesChanged: FileChange[];
  cost: PiCost;
  provider?: string;
  model?: string;
  hadError: boolean;
  /** True if at least one agent_end was seen (the run reached completion). */
  completed: boolean;
}

export function extract(events: PiEvent[]): Extracted {
  const failedCalls = new Set<string>();
  for (const e of events) {
    if (e.type === "tool_execution_end" && e.isError && e.toolCallId) {
      failedCalls.add(e.toolCallId);
    }
  }

  const changes = new Map<string, FileChange["kind"]>();
  for (const e of events) {
    if (e.type !== "tool_execution_start") continue;
    const kind = WRITE_TOOLS[e.toolName];
    const path = e.args?.path;
    if (!kind || typeof path !== "string") continue;
    if (e.toolCallId && failedCalls.has(e.toolCallId)) continue;
    // First write wins as "create"; a later edit shouldn't downgrade it.
    if (!changes.has(path)) changes.set(path, kind);
  }

  const cost = { ...ZERO_COST };
  const seenResponses = new Set<string>();
  let finalText = "";
  let provider: string | undefined;
  let model: string | undefined;
  let completed = false;
  let hadError = false;

  // Count each assistant response's cost once (dedupe by responseId) so fix-loop
  // resumes that replay earlier turns don't inflate the total.
  const consider = (msg: any): void => {
    if (!msg || msg.role !== "assistant") return;
    const text = textOf(msg);
    if (text) finalText = text; // last assistant text wins
    if (msg.provider) provider = msg.provider;
    if (msg.model) model = msg.model;
    const rid: unknown = msg.responseId;
    if (typeof rid === "string") {
      if (seenResponses.has(rid)) return;
      seenResponses.add(rid);
    }
    addCost(cost, msg.usage?.cost);
  };

  for (const e of events) {
    if (e.type === "message_end") consider(e.message);
    if (e.type === "agent_end") {
      completed = true;
      if (Array.isArray(e.messages)) for (const m of e.messages) consider(m);
    }
    if (e.type === "extension_error" || e.type === "error") hadError = true;
  }

  return {
    finalText: finalText.trim(),
    toolFilesChanged: [...changes.entries()].map(([path, kind]) => ({ path, kind })),
    cost,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    hadError,
    completed,
  };
}

function textOf(message: { content?: Array<{ type: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

function addCost(acc: PiCost, c: Partial<PiCost> | undefined): void {
  if (!c) return;
  acc.input += c.input ?? 0;
  acc.output += c.output ?? 0;
  acc.cacheRead += c.cacheRead ?? 0;
  acc.cacheWrite += c.cacheWrite ?? 0;
  acc.total += c.total ?? 0;
}
