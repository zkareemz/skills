// @zkareemz/skills — a collection of agent skills.
// Dispatches on the first arg (the skill namespace). Currently: `delegate`.

import { delegateMain } from "./delegate/index.js";

const PKG_VERSION = "0.1.0";

const TOP_HELP = `@zkareemz/skills — a collection of agent skills.

Usage: @zkareemz/skills <skill> <command> [options]

Skills:
  delegate    Offload implementation work to the pi coding agent (pi-delegate)

Run \`@zkareemz/skills delegate help\` for delegate commands.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const entry = process.argv[1] ?? "";
  const skill = argv[0];

  switch (skill) {
    case "delegate":
      return delegateMain(argv.slice(1), entry);
    case "--version":
    case "-v":
      process.stdout.write(PKG_VERSION + "\n");
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(TOP_HELP + "\n");
      return;
    default:
      process.stderr.write(`unknown skill: ${skill}\n\n${TOP_HELP}\n`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
