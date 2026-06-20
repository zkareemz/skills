import { defineConfig } from "vitest/config";

// The source uses NodeNext-style `./foo.js` specifiers that point at `./foo.ts`.
// This pre-resolver rewrites relative `.js` imports to `.ts` so vitest can load
// the TypeScript source directly.
export default defineConfig({
  plugins: [
    {
      name: "js-to-ts-resolver",
      enforce: "pre",
      async resolveId(source, importer) {
        if (importer && source.startsWith(".") && source.endsWith(".js")) {
          const resolved = await this.resolve(source.slice(0, -3) + ".ts", importer, {
            skipSelf: true,
          });
          if (resolved) return resolved.id;
        }
        return null;
      },
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
  },
});
