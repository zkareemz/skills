---
name: pi-delegate
description: >-
  Offload implementation work to the pi coding agent. Use when the user wants to
  "delegate", "hand off", or "offload" execution of a plan/task/feature so that
  YOU (the host agent) do not implement it yourself — pi does the coding while you
  stay the planner/reviewer. Also use after producing a plan when the user says
  "delegate execution", "let pi build this", or "run this with pidelegate".
license: MIT
metadata:
  engine: "npx -y zkareemz-skills delegate"
---

# pi-delegate

You are a **host coding agent** (Claude Code, Codex, Gemini, Cursor, Windsurf, …).
This skill lets you **delegate implementation to the `pi` coding agent** instead of
editing code yourself. You write a precise brief, hand it to `pidelegate`, pi does
the work in the **current repository**, and you get back a compact result to review
and continue from. The user never leaves your session.

## Golden rules

1. **Do NOT implement the task yourself.** Your job is to specify the work, kick off
   delegation, wait, then review pi's result and continue with the user.
2. **Briefs must be self-contained.** The delegated pi starts cold with **no access
   to this conversation**. Put everything it needs into the brief.
3. **Keep your context clean.** Read the compact JSON result, not raw logs. Only run
   `logs` when actively debugging a failure.
4. Pi edits the **real working tree** with the user's permissions (no sandbox). If
   the user wants isolation, that's on them (e.g. a branch); pidelegate won't add it.

## Prerequisites (check once)

- `pi` must be installed and authenticated in the environment. The engine runs a
  preflight and returns `{ "ok": false, "error": ... }` if pi is missing/unauthed —
  relay that to the user.
- The engine is run on demand via `npx -y zkareemz-skills delegate …` (no install).

## Workflow

### 1. Write the brief(s)

For a single task, create a markdown brief file, e.g. `.pidelegate-brief.md`:

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

## Context                    <!-- optional but recommended -->
Greenfield service in this repo. Decisions made with the user: use `jsonwebtoken`,
15-minute access tokens, secret from `process.env.JWT_SECRET`.

## Relevant paths             <!-- optional -->
src/server.ts, src/routes/, src/middleware/

## Constraints                <!-- optional -->
Match the existing code style. Don't add new heavy dependencies.

## Out of scope               <!-- optional -->
Refresh tokens, password reset.
```

For a multi-step plan, write **one self-contained brief per step**. Because pi runs
them **sequentially in the same repo**, a later step's pi can simply read the files
an earlier step created — but still spell out what it needs. Put the briefs in a
folder (`tasks/01-x.md`, `tasks/02-y.md`, …) and pass `--tasks tasks/`.

### 2. Start the delegation

```bash
npx -y zkareemz-skills delegate run .pidelegate-brief.md
# or a list:
npx -y zkareemz-skills delegate run --tasks tasks/
```

This prints `{"ok":true,"job_id":"<id>", ...}` and returns immediately — pi runs in
the background so long implementations don't trip your tool timeouts.

Useful flags: `--model`, `--provider`, `--thinking <off|low|medium|high|xhigh>`,
`--tools <list>`, `--timeout 30m`, `--max-fix 2`, `--fail-fast`, `--parallel`,
`--cwd <dir>`.

### 3. Wait for completion (poll)

```bash
npx -y zkareemz-skills delegate wait <job_id>
```

`wait` blocks up to a safe budget (default 8m) and returns either:
- `{"state":"running","progress":{...}}` → **call `wait` again** to keep polling.
  Between waits you may keep talking to the user.
- `{"state":"done","result":{...}}` → the job finished; read the result.

### 4. Read the result and continue

The `result` is a compact rollup:

```json
{
  "overall": "success | partial | failed",
  "tasks": [{
    "taskId": "...", "status": "success",
    "summary": "what pi changed",
    "filesChanged": [{"path":"src/...","kind":"create|modify"}],
    "verification": {"passed": true, "results": [...]},
    "acceptance": {"met": true},
    "blockers": [],
    "cost": {"total": 0.0123},
    "pointers": {"eventsPath":"...","sessionPath":"..."}
  }],
  "totals": {"tasks":1,"succeeded":1,...}
}
```

- **success** → summarize what pi did to the user (mention `filesChanged`) and move
  to the next step of the plan.
- **partial / failed** → tell the user, surface `blockers` and the failing
  `verification`. Offer to (a) refine the brief and re-delegate, or (b) `resume`.

## Other commands

- `delegate status <id>` — quick snapshot.
- `delegate result <id>` — fetch the final rollup again.
- `delegate logs <id> [--follow]` — human-readable event log (debugging only).
- `delegate abort <id>` — stop a running job; captures partial result.
- `delegate resume <id>` — re-run non-succeeded tasks (reuses pi sessions; already
  successful tasks are skipped).
- `delegate list` — recent jobs.

## How it works (so you can reason about failures)

- The engine spawns `pi --mode json` per task in the repo; pi implements unattended.
- After pi stops, the engine **runs your `verify` commands** as the objective gate.
- If verify fails, the engine resumes the same pi session with the failing output
  and lets pi fix it, up to `--max-fix` times, before reporting `partial`.
- Results combine mechanical facts (files changed, cost, verify exit codes) with
  pi's own end-of-run self-report.
