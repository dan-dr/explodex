import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSdkPackage, SDK_PACKAGE_ROOT } from "../helpers/pack.ts";

type RawSourceMap = {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  mappings: string;
  names?: string[];
};

/**
 * Minimal VLQ decoder for sampling the first generated mapping.
 * Sufficient to prove package-relative sources and non-empty mappings.
 */
function decodeVlq(segment: string): number[] {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: number[] = [];
  let i = 0;
  while (i < segment.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      const ch = segment[i];
      i += 1;
      if (ch === undefined) throw new Error("truncated VLQ");
      byte = chars.indexOf(ch);
      if (byte < 0) throw new Error(`invalid VLQ char ${ch}`);
      result |= (byte & 31) << shift;
      shift += 5;
    } while (byte & 32);
    const negated = result & 1;
    const value = result >> 1;
    values.push(negated ? -value : value);
  }
  return values;
}

describe("VAL-SDK-005 SDK source maps are accurate, portable, and SDK-only", () => {
  test("runtime map is package-relative and maps generated code to authored SDK TS", async () => {
    await buildSdkPackage();
    const jsPath = join(SDK_PACKAGE_ROOT, "dist", "runtime", "explodex-runtime.iife.js");
    const mapPath = join(SDK_PACKAGE_ROOT, "dist", "runtime", "explodex-runtime.iife.js.map");
    const js = await readFile(jsPath, "utf8");
    const mapText = await readFile(mapPath, "utf8");

    expect(js).toContain("sourceMappingURL=explodex-runtime.iife.js.map");
    expect(js).not.toMatch(/sourceMappingURL=\/|sourceMappingURL=file:/);

    const map = JSON.parse(mapText) as RawSourceMap;
    expect(map.version).toBe(3);
    expect(Array.isArray(map.sources)).toBe(true);
    expect(map.sources.length).toBeGreaterThan(0);
    expect(typeof map.mappings).toBe("string");
    expect(map.mappings.length).toBeGreaterThan(0);

    for (const source of map.sources) {
      expect(source.startsWith("/")).toBe(false);
      expect(/^[A-Za-z]:[\\/]/.test(source)).toBe(false);
      expect(source.includes("/Users/")).toBe(false);
      expect(source.includes("/tmp/")).toBe(false);
      expect(source.includes("plugin-registry")).toBe(false);
      expect(source.includes("packages/cli")).toBe(false);
      expect(source.includes("vendor/")).toBe(false);
      expect(source.includes("extracted/")).toBe(false);
      // Sources should be package-relative SDK TypeScript.
      expect(source.includes("src/")).toBe(true);
      expect(source.endsWith(".ts")).toBe(true);
    }

    // Sample the first non-empty mapping segment (leading blank generated lines are common).
    const firstSegment =
      map.mappings
        .split(";")
        .flatMap((line) => line.split(","))
        .find((segment) => segment.length > 0) ?? "";
    expect(firstSegment.length).toBeGreaterThan(0);
    const decoded = decodeVlq(firstSegment);
    // Standard segment: generatedColumn, sourceIndex, originalLine, originalColumn, [nameIndex]
    expect(decoded.length).toBeGreaterThanOrEqual(4);
    const sourceIndex = decoded[1] ?? -1;
    const originalLine = decoded[2] ?? -1;
    const originalColumn = decoded[3] ?? -1;
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(sourceIndex).toBeLessThan(map.sources.length);
    expect(originalLine).toBeGreaterThanOrEqual(0);
    expect(originalColumn).toBeGreaterThanOrEqual(0);

    // Thrown stack frames from the IIFE should reference the generated file name,
    // which the map binds back to authored sources above.
    expect(js).toContain("installRuntime");
    const authored = map.sources.some(
      (source) => source.endsWith("bootstrap.ts") || source.endsWith("index.ts"),
    );
    expect(authored).toBe(true);
  }, 120_000);
});
