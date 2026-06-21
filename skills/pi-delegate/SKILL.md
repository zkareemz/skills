---
name: pi-delegate
description: >-
  Offload implementation work to the pi coding agent. Use when the user wants to
  "delegate", "hand off", or "offload" execution of a plan/task/feature so that
  YOU (the host agent) do not implement it yourself — pi does the coding while you
  stay the planner/reviewer. Also use after producing a plan when the user says
  "delegate execution", "let pi build this", or "run this with pidelegate". Covers
  writing the brief, dispatching via the bundled engine, polling to completion,
  reviewing the verified result, and continuing. DO NOT use for work small enough
  to do inline, or when the user wants you to write the code directly.
license: MIT
metadata:
  version: 0.2.0
  engine: 'node "<skill-dir>/scripts/pidelegate.cjs" delegate'
---

# pi-delegate

You are a **host coding agent** (Claude Code, Codex, Gemini, Cursor, Windsurf, …).
This skill lets you **delegate implementation to the `pi` coding agent** instead of
editing code yourself. You write a precise brief, hand it to the engine, pi does the
work in the **current repository**, the engine **verifies it**, and you get back a
compact result to review and continue from. The user never leaves your session.

Nothing here is specific to one host — the loop only needs the ability to run a
shell command and read JSON.

## Golden rules

1. **Do NOT implement the task yourself.** You specify the work and own the
   judgment; pi does the typing; you review and continue.
2. **Briefs must be self-contained.** The delegated pi starts cold with **no access
   to this conversation**. Everything it needs goes in the brief.
3. **Keep your context clean.** Read the compact JSON result, not raw logs. Only
   reach for `logs` when debugging a failure.
4. Pi edits the **real working tree** with the user's permissions (no sandbox). The
   engine warns if the tree is dirty; if the user wants isolation, use `--parallel`
   (git worktrees) or have them branch first.

## Running the engine

Throughout, `<skill-dir>` is this skill's installed directory (the folder holding
this `SKILL.md`). Claude Code prints it as "Base directory for this skill" on load;
otherwise find it with `find ~ -name pidelegate.cjs -path '*pi-delegate*'`.

Set a shell alias once, then use `$PI` in every step:

```bash
PI='node "<skill-dir>/scripts/pidelegate.cjs" delegate'   # fast, zero-install (preferred)
# fallback if the bundle isn't present: PI='npx -y @zkareemz/skills delegate'
```

**Prerequisite:** `pi` installed and authenticated on PATH (`pi --version`). The
engine preflights this and returns `{ "ok": false, "error": … }` if not — relay it.

## The loop

### 1. Write the brief(s)

Single task → a markdown brief file (`.pidelegate-brief.md`):

```markdown
---
verify:                       # REQUIRED: commands the engine runs to gate success
  - npm test
  - npm run typecheck
# id: add-jwt-auth            # optional
# depends_on: []              # optional (only affects --parallel grouping)
---
## Objective                  <!-- REQUIRED -->
Add JWT-based authentication to the Express API.

## Acceptance criteria         <!-- REQUIRED -->
- POST /login returns a signed JWT for valid credentials.
- Protected routes reject requests without a valid token.

## Context                    <!-- optional, recommended: decisions made with the user -->
## Relevant paths / Constraints / Out of scope   <!-- optional -->
```

Discover the **real** verify commands from the repo (package.json scripts,
CLAUDE.md/AGENTS.md, Makefile) — don't guess. Multi-step plan → one self-contained
brief per step in a folder (`tasks/01-x.md`, `tasks/02-y.md`), passed with `--tasks`.

### 2. Dispatch

```bash
$PI run .pidelegate-brief.md            # → {"ok":true,"job_id":"…"}
$PI run --tasks tasks/                  # ordered, sequential, in-place
```

Returns a **job_id immediately**; pi runs in the background, so long
implementations don't trip your tool timeouts. Useful flags: `--model`,
`--provider`, `--thinking <off|low|medium|high|xhigh>`, `--tools`, `--timeout 30m`,
`--max-fix 2`, `--fail-fast`, `--read-only`, `--parallel [--max-parallel N]`,
`--cwd <dir>`.

### 3. Wait (poll)

```bash
$PI wait <job_id>      # blocks up to a safe budget, then returns
```

- `{"state":"running","progress":{…}}` → **call `wait` again** (you may chat with
  the user between waits).
- `{"state":"done","result":{…}}` → finished; review the result.

### 4. Review — the engine verified, but spot-check

The engine already re-ran your `verify` commands as the gate, so a `success` means
they passed. Still:
- **Read the diff against the brief** (`filesChanged` is your starting point): did pi
  do what was asked — nothing more (scope creep), nothing less?
- For `partial`/`failed`, surface `verification` output and `blockers`; offer to
  refine the brief and re-delegate, or `$PI resume <job_id>`.

### 5. Continue

On `success`, summarize what pi changed to the user and move to the next step. The
engine does **not** commit — committing stays the user's/your call after review.

## Other commands

`$PI status <id>` · `$PI result <id>` · `$PI logs <id> [--follow]` ·
`$PI abort <id>` (stop, capture partial) · `$PI resume <id>` (re-run non-succeeded
tasks) · `$PI list`.

## How it works (so you can reason about failures)

- Spawns `pi --mode json` per task; pi implements unattended in the repo.
- After pi stops, the engine runs your `verify` commands as the **objective gate**.
- On a red verify it resumes pi's session to fix it, up to `--max-fix` times, then
  reports `partial`.
- `filesChanged` comes from `git status` (catches everything on disk) unioned with
  pi's tool events; cost/summary from pi's run, cross-checked with its self-report.
- Sequential **in-place** by default; `--parallel` runs each delegate in its own git
  worktree (up to `--max-parallel`) and merges back. Jobs live in
  `~/.pidelegate/jobs/<id>/`.

## Authorization & judgment

Delegation is something the user opts into; once they have ("delegate this",
"proceed"), running and verifying the work is the agreed contract. Two limits:
**surface, don't absorb** — report pi's notable design decisions and any
defensible-but-unasked changes rather than silently accepting them; and **stop for
scope changes** — if finishing correctly needs going beyond the brief, ask; don't
expand the mandate yourself.

## What this skill does NOT do

- It does not commit for you — review the diff first, then commit.
- It does not judge code quality — pair it with your review/guard skills.
- It is not pi reviewing *your* work — it's you delegating *to* pi.
