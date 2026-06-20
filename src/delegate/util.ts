// Small CLI helpers.

// "30m" | "600s" | "2h" | "500ms" | "30000" (bare = milliseconds).
export function parseDuration(input: string | undefined, fallbackMs: number): number {
  if (!input) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(input.trim());
  if (!m) throw new Error(`invalid duration: ${input}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n; // "ms" or bare number
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function fail(message: string, code = 1): never {
  printJson({ ok: false, error: message });
  process.exit(code);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}
