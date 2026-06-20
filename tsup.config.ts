import { defineConfig } from "tsup";

// CLI bundle for `npx -y zkareemz-skills ...`. Dependencies are left external
// (npm installs them when the package is fetched) — bundling CJS deps like `yaml`
// into ESM triggers dynamic-require failures. A shebang is prepended for exec.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
