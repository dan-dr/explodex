import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * Read the packed package version from the nearest package.json.
 * Deterministic and secret-free; never reads environment secrets.
 */
export function readCliPackageVersion(): string {
  if (cached !== null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "package.json"),
    join(here, "..", "package.json"),
    join(here, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name === "explodex" && typeof parsed.version === "string") {
        cached = parsed.version;
        return cached;
      }
    } catch {
      // try next
    }
  }
  cached = "0.0.0";
  return cached;
}
