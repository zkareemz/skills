# @zkareemz/skills

A collection of agent skills for coding harnesses. The first skill is
**`pi-delegate`**: offload implementation work from your host agent (Claude Code,
Codex, Gemini, Cursor, Windsurf, …) to the [`pi`](https://pi.dev) coding agent.

Your host agent stays the **planner/reviewer**; pi does the actual coding in your
repo, unattended; you get back a compact, verified result and continue — without
leaving your session.

## Install the skill

Skills are installed with [skills.sh](https://skills.sh):

```bash
npx skills add zkareemz/skills
```

Pick `pi-delegate` and your target agent when prompted. The engine itself is run
on demand via `npx -y @zkareemz/skills delegate …` (no separate install).

**Prerequisites:** [`pi`](https://pi.dev) installed and authenticated on your PATH.

## Use it directly (CLI)

```bash
# 1. Write a self-contained brief (objective + acceptance + verify are required)
cat > brief.md <<'EOF'
---
verify: ["npm test"]
---
## Objective
Add a /health endpoint returning {status:"ok"}.
## Acceptance criteria
GET /health returns 200 with {status:"ok"}.
EOF

# 2. Start a background job (prints a job_id immediately)
npx -y @zkareemz/skills delegate run brief.md

# 3. Poll until done (returns within a safe budget; call again if still running)
npx -y @zkareemz/skills delegate wait <job_id>

# 4. Read the compact result / drill down
npx -y @zkareemz/skills delegate result <job_id>
npx -y @zkareemz/skills delegate logs <job_id>
```

A multi-step plan is a folder of briefs run sequentially in the same repo:

```bash
npx -y @zkareemz/skills delegate run --tasks tasks/        # 01-x.md, 02-y.md, …
```

### Commands

| Command | Purpose |
|---|---|
| `run <brief\|--tasks dir> [flags]` | Start a job; prints `job_id` (or `--wait` to poll inline) |
| `wait <id> [--budget 8m]` | Block up to budget → `running`+progress or `done`+result |
| `status <id>` / `result <id>` | Snapshot / final rollup (JSON) |
| `logs <id> [--follow]` | Human-readable event log |
| `abort <id>` / `resume <id>` | Stop (capture partial) / re-run non-succeeded tasks |
| `list` | Recent jobs |

Run flags: `--model --provider --thinking --tools --timeout 30m --max-fix 2
--fail-fast --read-only --parallel [--max-parallel N] --cwd <dir>`.

The engine ships **bundled inside the skill** (`skills/pi-delegate/scripts/pidelegate.cjs`),
so a host can run it with zero install: `node "<skill-dir>/scripts/pidelegate.cjs"
delegate …`. The `npx -y @zkareemz/skills …` path above is the published-package
alternative.

### How it works

- The engine spawns `pi --mode json` per task; pi implements in the **real repo**.
- After pi stops, the engine runs your **`verify` commands** as the success gate.
- On a red verify it resumes pi's session to fix it, up to `--max-fix` times, then
  reports `partial`.
- `filesChanged` comes from `git status` (catches anything on disk, incl. bash
  edits/deletes/renames) unioned with pi's tool events; combined with cost and pi's
  cross-checked self-report. Jobs live under `~/.pidelegate/jobs/<id>/`.
- A dead supervisor is reconciled to `error` on the next `status`/`wait` (no zombie
  jobs); `--read-only` delegates with pi's non-mutating tools and an optional gate.
- Default execution is **sequential, in-place** (no isolation; your git is your
  safety net). `--parallel` runs each delegate in its own git worktree and merges.

## Develop

```bash
npm install
npm run build        # bundle to dist/cli.js (tsup)
npm test             # vitest: unit + integration (uses a mock pi)
npm run typecheck
```

Set `PIDELEGATE_PI_BIN` to point at a specific/mock pi, and `PIDELEGATE_HOME` to
relocate the job store.
