import { defineConfig } from "tsup";

// Two outputs from one CLI source:
//
//  1. dist/cli.js  — ESM, deps left external (npm installs them). For the npm
//     package / `npx -y @zkareemz/skills`.
//  2. skills/pi-delegate/scripts/pidelegate.cjs — CJS, fully self-contained
//     (deps bundled), committed into the skill so skills.sh ships it and the
//     host can run it with zero install/network: `node <skill-dir>/scripts/
//     pidelegate.cjs`. CJS avoids the ESM dynamic-require issue with `yaml`.
export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { pidelegate: "src/cli.ts" },
    outDir: "skills/pi-delegate/scripts",
    format: ["cjs"],
    target: "node18",
    platform: "node",
    noExternal: [/.*/],
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
