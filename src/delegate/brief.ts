// Parse and validate task briefs, and render them into a pi prompt.
//
// A brief is markdown with optional YAML frontmatter:
//
//   ---
//   id: add-auth                 # optional
//   verify: ["npm test"]         # REQUIRED (non-empty)
//   depends_on: []               # optional
//   ---
//   ## Objective                 # REQUIRED
//   ## Acceptance criteria        # REQUIRED
//   ## Context / Relevant paths / Constraints / Out of scope   # optional
//
// A task list is a directory of .md briefs, a single .md with `===`-separated
// briefs, or a tasks.(yaml|json) array of brief objects.

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Brief } from "./types.js";

export class BriefError extends Error {}

interface Frontmatter {
  id?: string;
  verify?: unknown;
  depends_on?: unknown;
  dependsOn?: unknown;
}

const HEADING_FIELDS: Record<string, keyof Brief> = {
  objective: "objective",
  "acceptance criteria": "acceptance",
  acceptance: "acceptance",
  context: "context",
  why: "context",
  "relevant paths": "paths",
  paths: "paths",
  constraints: "constraints",
  "out of scope": "outOfScope",
  "out-of-scope": "outOfScope",
};

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

function splitFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { fm: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { fm: {}, body: normalized };
  const fmText = normalized.slice(4, end);
  const rest = normalized.slice(end + 4).replace(/^[^\n]*\n/, ""); // drop closing line
  let fm: Frontmatter = {};
  try {
    fm = (parseYaml(fmText) as Frontmatter) ?? {};
  } catch (e) {
    throw new BriefError(`invalid YAML frontmatter: ${(e as Error).message}`);
  }
  return { fm, body: rest };
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split("\n");
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) sections[current] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      current = m[1]!.trim().toLowerCase();
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v !== "string") throw new BriefError(`${field} must be a list of strings`);
      return v;
    });
  }
  throw new BriefError(`${field} must be a string or list of strings`);
}

/** Parse a single brief from markdown text. `fallbackId` used when none given. */
export function parseBrief(raw: string, fallbackId: string): Brief {
  const { fm, body } = splitFrontmatter(raw);
  const sections = parseSections(body);

  const brief: Partial<Brief> = {};
  for (const [heading, field] of Object.entries(HEADING_FIELDS)) {
    const text = sections[heading];
    if (text && !brief[field]) (brief as Record<string, string>)[field] = text;
  }

  const verify = asStringArray(fm.verify, "verify");
  const dependsOn = asStringArray(fm.depends_on ?? fm.dependsOn, "depends_on");
  const id = (typeof fm.id === "string" && fm.id.trim()) || fallbackId;

  return validateBrief({ ...brief, id, verify, dependsOn });
}

/** Validate a (possibly object-sourced) brief, throwing BriefError on problems. */
export function validateBrief(input: Partial<Brief>): Brief {
  const missing: string[] = [];
  if (!input.objective?.trim()) missing.push("objective (## Objective)");
  if (!input.acceptance?.trim()) missing.push("acceptance criteria (## Acceptance criteria)");
  const verify = input.verify ?? [];
  if (verify.length === 0) missing.push("verify (frontmatter `verify:` with >=1 command)");
  if (missing.length) {
    throw new BriefError(
      `brief "${input.id ?? "?"}" is missing required fields: ${missing.join(", ")}`,
    );
  }
  return {
    id: input.id ?? slug(input.objective!),
    objective: input.objective!.trim(),
    acceptance: input.acceptance!.trim(),
    verify,
    dependsOn: input.dependsOn ?? [],
    ...(input.context ? { context: input.context.trim() } : {}),
    ...(input.paths ? { paths: input.paths.trim() } : {}),
    ...(input.constraints ? { constraints: input.constraints.trim() } : {}),
    ...(input.outOfScope ? { outOfScope: input.outOfScope.trim() } : {}),
  };
}

function fromObject(obj: Record<string, unknown>, fallbackId: string): Brief {
  return validateBrief({
    id: typeof obj.id === "string" ? obj.id : fallbackId,
    objective: typeof obj.objective === "string" ? obj.objective : undefined,
    acceptance:
      typeof obj.acceptance === "string"
        ? obj.acceptance
        : typeof obj.acceptance_criteria === "string"
          ? (obj.acceptance_criteria as string)
          : undefined,
    verify: asStringArray(obj.verify, "verify"),
    dependsOn: asStringArray(obj.depends_on ?? obj.dependsOn, "depends_on"),
    context: typeof obj.context === "string" ? obj.context : undefined,
    paths: typeof obj.paths === "string" ? obj.paths : undefined,
    constraints: typeof obj.constraints === "string" ? obj.constraints : undefined,
    outOfScope:
      typeof obj.out_of_scope === "string"
        ? (obj.out_of_scope as string)
        : typeof obj.outOfScope === "string"
          ? (obj.outOfScope as string)
          : undefined,
  });
}

/** Load one-or-many briefs from a path (file or directory). */
export function loadBriefs(inputPath: string): Brief[] {
  if (!existsSync(inputPath)) throw new BriefError(`input not found: ${inputPath}`);
  const st = statSync(inputPath);

  if (st.isDirectory()) {
    const files = readdirSync(inputPath)
      .filter((f) => f.endsWith(".md"))
      .sort();
    if (files.length === 0) throw new BriefError(`no .md briefs in directory: ${inputPath}`);
    return files.map((f, i) =>
      parseBrief(readFileSync(join(inputPath, f), "utf8"), slug(basename(f, ".md")) || `task-${i + 1}`),
    );
  }

  const ext = extname(inputPath).toLowerCase();
  const raw = readFileSync(inputPath, "utf8");

  if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
    const data = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
    const arr = Array.isArray(data) ? data : Array.isArray((data as { tasks?: unknown }).tasks) ? (data as { tasks: unknown[] }).tasks : null;
    if (!arr) throw new BriefError(`expected a top-level array (or { tasks: [...] }) in ${inputPath}`);
    return arr.map((o, i) => fromObject(o as Record<string, unknown>, `task-${i + 1}`));
  }

  // Single markdown file, possibly several briefs separated by a line of `===`.
  const chunks = raw.replace(/\r\n/g, "\n").split(/\n={3,}\s*\n/);
  if (chunks.length === 1) {
    return [parseBrief(raw, slug(basename(inputPath, ".md")) || "task-1")];
  }
  return chunks
    .filter((c) => c.trim())
    .map((c, i) => parseBrief(c, `task-${i + 1}`));
}

/** Ensure task ids are unique (suffix duplicates) so job dirs don't collide. */
export function dedupeIds(briefs: Brief[]): Brief[] {
  const seen = new Map<string, number>();
  return briefs.map((b) => {
    const n = seen.get(b.id) ?? 0;
    seen.set(b.id, n + 1);
    return n === 0 ? b : { ...b, id: `${b.id}-${n + 1}` };
  });
}

const SENTINEL = "pidelegate-report";

/** Render a brief into the prompt text handed to a fresh pi session. */
export function renderPrompt(brief: Brief): string {
  const parts: string[] = [];
  parts.push(
    "You are an autonomous implementation agent invoked by `pidelegate`. " +
      "Implement the task below completely, editing files in the current repository. " +
      "You have no prior conversation context — everything you need is in this brief. " +
      "Work until the acceptance criteria are met; run relevant checks yourself as you go.",
  );
  parts.push(`\n## Objective\n${brief.objective}`);
  parts.push(`\n## Acceptance criteria\n${brief.acceptance}`);
  if (brief.context) parts.push(`\n## Context\n${brief.context}`);
  if (brief.paths) parts.push(`\n## Relevant paths\n${brief.paths}`);
  if (brief.constraints) parts.push(`\n## Constraints\n${brief.constraints}`);
  if (brief.outOfScope) parts.push(`\n## Out of scope\n${brief.outOfScope}`);
  parts.push(
    `\n## Verification\nThese commands will be run to check your work; make them pass:\n` +
      brief.verify.map((c) => `- \`${c}\``).join("\n"),
  );
  parts.push(
    `\n## Final report (required)\n` +
      `When you are done, output as your final message a fenced code block tagged \`${SENTINEL}\` ` +
      `containing JSON with this shape:\n` +
      "```" +
      SENTINEL +
      "\n" +
      JSON.stringify(
        {
          summary: "<2-4 sentence summary of what you changed>",
          acceptance_met: true,
          blockers: ["<anything you could not do, or empty>"],
        },
        null,
        2,
      ) +
      "\n```",
  );
  return parts.join("\n");
}

/** Render the follow-up prompt used when verification fails (fix-loop). */
export function renderFixPrompt(brief: Brief, verifyTail: string): string {
  return (
    `The verification step failed. Fix the issues and ensure all acceptance criteria are met.\n\n` +
    `## Failing verification output (tail)\n${verifyTail}\n\n` +
    `Re-read the relevant files, make the necessary changes, then finish with an updated ` +
    `\`${SENTINEL}\` report block as before.`
  );
}

export { SENTINEL };
