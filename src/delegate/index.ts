// Router for the `delegate` skill namespace.

import {
  cmdRun,
  cmdWait,
  cmdStatus,
  cmdResult,
  cmdList,
  cmdAbort,
  cmdResume,
  cmdLogs,
  cmdPlan,
  cmdSupervise,
} from "./commands.js";
import { fail } from "./util.js";

const HELP = `pidelegate — offload implementation work to the pi coding agent.

Usage: zkareemz-skills delegate <command> [options]

Commands:
  run <brief.md | --tasks <file|dir>>   Start a delegated job (prints job_id)
      [--model m --provider p --thinking lvl --tools list]
      [--parallel] [--fail-fast] [--timeout 30m] [--max-fix 2] [--cwd .] [--wait]
  wait <id> [--budget 8m]               Block up to budget; print running|done+result
  status <id>                           Snapshot of a job
  result <id>                           Final compact rollup (JSON)
  logs <id> [--follow]                  Human-readable event log
  abort <id>                            Request abort; capture partial
  resume <id>                           Re-run non-succeeded tasks
  list                                  List recent jobs
  plan --from <plan.md>                 (planned) propose a task list

All machine output is JSON. Set PIDELEGATE_PI_BIN to override the pi binary.`;

export async function delegateMain(argv: string[], entry: string): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "run":
      return cmdRun(rest, entry);
    case "wait":
      return cmdWait(rest);
    case "status":
      return cmdStatus(rest);
    case "result":
      return cmdResult(rest);
    case "logs":
      return cmdLogs(rest);
    case "abort":
      return cmdAbort(rest);
    case "resume":
      return cmdResume(rest, entry);
    case "list":
      return cmdList();
    case "plan":
      return cmdPlan(rest);
    case "__supervise":
      return cmdSupervise(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP + "\n");
      return;
    default:
      fail(`unknown command: ${sub}. Run \`delegate help\` for usage.`);
  }
}
