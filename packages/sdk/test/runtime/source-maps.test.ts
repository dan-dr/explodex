import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { buildSdkPackage, SDK_PACKAGE_ROOT } from "../helpers/pack.ts";

type RawSourceMap = {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  mappings: string;
  names?: string[];
};

type DecodedMapping = {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
};

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

function decodeMappings(mappings: string): DecodedMapping[] {
  const decoded: DecodedMapping[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  for (const [lineIndex, line] of mappings.split(";").entries()) {
    let generatedColumn = 0;
    for (const segment of line.split(",")) {
      if (segment.length === 0) continue;
      const values = decodeVlq(segment);
      generatedColumn += values[0] ?? 0;
      if (values.length < 4) continue;
      sourceIndex += values[1] ?? 0;
      originalLine += values[2] ?? 0;
      originalColumn += values[3] ?? 0;
      if (values.length >= 5) nameIndex += values[4] ?? 0;
      decoded.push({
        generatedLine: lineIndex + 1,
        generatedColumn,
        sourceIndex,
        originalLine: originalLine + 1,
        originalColumn,
      });
    }
  }
  void nameIndex;
  return decoded;
}

function generatedPosition(source: string, needle: string): {
  line: number;
  column: number;
} {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`Generated probe not found: ${needle}`);
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines.at(-1)?.length ?? 0,
  };
}

function originalPositionFor(
  mappings: readonly DecodedMapping[],
  line: number,
  column: number,
): DecodedMapping {
  const candidates = mappings.filter(
    (mapping) =>
      mapping.generatedLine === line && mapping.generatedColumn <= column,
  );
  const mapping = candidates.at(-1);
  if (mapping === undefined) {
    throw new Error(`No source-map segment for generated ${line}:${column}`);
  }
  return mapping;
}

async function listMapFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listMapFiles(full)));
    else if (entry.name.endsWith(".map")) result.push(full);
  }
  return result.sort();
}

const FORBIDDEN_SOURCE_MARKERS = [
  "/Users/",
  "/home/",
  "/private/var/",
  "/tmp/",
  "\\Users\\",
  "node_modules",
  "plugin-registry",
  "packages/cli",
  "vendor/",
  "extracted/",
  "plugins/",
] as const;

describe("VAL-SDK-005 SDK source maps are accurate, portable, and SDK-only", () => {
  test("all generated maps are package-relative and the runtime map is semantically accurate", async () => {
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

    for (const generatedMapPath of await listMapFiles(
      join(SDK_PACKAGE_ROOT, "dist"),
    )) {
      const generatedMap = JSON.parse(
        await readFile(generatedMapPath, "utf8"),
      ) as RawSourceMap;
      expect(generatedMap.sourcesContent?.length).toBe(
        generatedMap.sources.length,
      );
      for (const [sourceIndex, source] of generatedMap.sources.entries()) {
        expect(source.startsWith("src/")).toBe(true);
        expect(source.endsWith(".ts")).toBe(true);
        expect(source.startsWith("/")).toBe(false);
        expect(/^[A-Za-z]:[\\/]/.test(source)).toBe(false);
        for (const marker of FORBIDDEN_SOURCE_MARKERS) {
          expect(source.includes(marker)).toBe(false);
        }
        expect(generatedMap.sourcesContent?.[sourceIndex]).toBe(
          await readFile(join(SDK_PACKAGE_ROOT, source), "utf8"),
        );
      }
    }

    const mappings = decodeMappings(map.mappings);
    expect(mappings.length).toBeGreaterThan(0);
    for (const needle of [
      "function createLogger",
      "function installRuntime",
      "REVIEW_SECURITY_WARNING",
    ]) {
      const generated = generatedPosition(js, needle);
      const original = originalPositionFor(
        mappings,
        generated.line,
        generated.column,
      );
      const source = map.sources[original.sourceIndex];
      const sourceContent = map.sourcesContent?.[original.sourceIndex];
      expect(source).toBeDefined();
      expect(sourceContent).toBeDefined();
      expect(source?.startsWith("src/")).toBe(true);
      expect(original.originalLine).toBeGreaterThan(0);
      expect(original.originalLine).toBeLessThanOrEqual(
        sourceContent?.split("\n").length ?? 0,
      );
      const authoredSource = await readFile(
        join(SDK_PACKAGE_ROOT, source ?? ""),
        "utf8",
      );
      expect(sourceContent).toBe(authoredSource);
    }

    // Throw from a clean browser-like realm, then map the generated SDK frame
    // to the exact authored TypeScript source coordinate.
    const realm = {
      console: {
        debug() {},
        error() {},
        info(): never {
          throw new Error("semantic-sdk-stack-probe");
        },
        log() {},
        warn() {},
      },
      setTimeout,
      clearTimeout,
    } as Record<string, unknown>;
    realm.window = realm;
    realm.globalThis = realm;
    const context = createContext(realm, {
      codeGeneration: { strings: false, wasm: false },
    });
    let thrown: Error | null = null;
    try {
      runInContext(js, context, {
        filename: "explodex-runtime.iife.js",
        displayErrors: true,
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown?.message).toBe("semantic-sdk-stack-probe");
    const frame = /explodex-runtime\.iife\.js:(\d+):(\d+)/.exec(
      thrown?.stack ?? "",
    );
    expect(frame).not.toBeNull();
    const generatedLine = Number(frame?.[1] ?? 0);
    const generatedColumn = Number(frame?.[2] ?? 0) - 1;
    const original = originalPositionFor(
      mappings,
      generatedLine,
      generatedColumn,
    );
    const mappedSource = map.sources[original.sourceIndex];
    expect(mappedSource).toBe("src/runtime/logger.ts");
    const mappedContent = map.sourcesContent?.[original.sourceIndex] ?? "";
    expect(mappedContent.split("\n")[original.originalLine - 1]).toContain(
      "console.info",
    );
  }, 120_000);
});
