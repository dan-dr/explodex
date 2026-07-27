import {
  comparePayloadPathsByUtf8Bytes,
  validateNormalizedPayloadPath,
} from "./payload-path.ts";
import { parse } from "acorn";

export type PluginSourceMapV3 = {
  version: 3;
  file: "index.js";
  sourceRoot: "";
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
};

export type SourceMapValidationResult =
  | { ok: true; map: PluginSourceMapV3 }
  | { ok: false; message: string; details?: Record<string, unknown> };

const SOURCE_MAP_KEYS = [
  "version",
  "file",
  "sourceRoot",
  "sources",
  "sourcesContent",
  "names",
  "mappings",
] as const;

const TYPESCRIPT_SOURCE = /^src\/.+\.tsx?$/u;
const BASE64_DIGITS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function failure(
  message: string,
  details?: Record<string, unknown>,
): SourceMapValidationResult {
  return { ok: false, message, details };
}

export function validatePluginSourceMapV3(options: {
  mapText: string;
  generatedSource: string;
}): SourceMapValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(options.mapText) as unknown;
  } catch (error: unknown) {
    return failure(
      error instanceof Error
        ? `index.js.map is not valid JSON: ${error.message}`
        : "index.js.map is not valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return failure("index.js.map must be a JSON object.");
  }
  const value = raw as Record<string, unknown>;
  const actualKeys = Object.keys(value).sort(comparePayloadPathsByUtf8Bytes);
  const expectedKeys = [...SOURCE_MAP_KEYS].sort(comparePayloadPathsByUtf8Bytes);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return failure("index.js.map has unexpected or missing fields.", {
      actualKeys,
      expectedKeys,
    });
  }
  if (value.version !== 3) {
    return failure("index.js.map version must be exactly 3.");
  }
  if (value.file !== "index.js") {
    return failure('index.js.map file must be exactly "index.js".');
  }
  if (value.sourceRoot !== "") {
    return failure('index.js.map sourceRoot must be exactly "".');
  }
  if (
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    !value.sources.every((source) => typeof source === "string")
  ) {
    return failure("index.js.map sources must be a non-empty string array.");
  }
  const sources = value.sources as string[];
  const seenSources = new Set<string>();
  for (const source of sources) {
    const validated = validateNormalizedPayloadPath(source, {
      kind: "file",
      maxUtf8Bytes: null,
    });
    if (
      !validated.ok ||
      !TYPESCRIPT_SOURCE.test(source) ||
      source.includes("://") ||
      seenSources.has(source)
    ) {
      return failure(
        "index.js.map sources must be unique package-relative TypeScript paths beneath src/.",
        { source },
      );
    }
    seenSources.add(source);
  }
  if (
    !Array.isArray(value.sourcesContent) ||
    value.sourcesContent.length !== sources.length ||
    !value.sourcesContent.every((content) => typeof content === "string")
  ) {
    return failure(
      "index.js.map sourcesContent must contain one string for every source.",
    );
  }
  if (
    !Array.isArray(value.names) ||
    !value.names.every((name) => typeof name === "string")
  ) {
    return failure("index.js.map names must be a string array.");
  }
  if (typeof value.mappings !== "string" || value.mappings.length === 0) {
    return failure("index.js.map mappings must be non-empty.");
  }
  const mappingsFailure = validateMappings(
    value.mappings,
    sources.length,
    value.names.length,
  );
  if (mappingsFailure !== null) return failure(mappingsFailure);

  const comments: Array<{
    type: "Line" | "Block";
    value: string;
    start: number;
    end: number;
  }> = [];
  try {
    parse(options.generatedSource, {
      ecmaVersion: "latest",
      sourceType: "script",
      onComment: comments,
    });
  } catch (error: unknown) {
    return failure(
      error instanceof Error
        ? `index.js is not valid classic-script JavaScript: ${error.message}`
        : "index.js is not valid classic-script JavaScript.",
    );
  }
  const sourceMapReferences = comments.filter((comment) =>
    /^[#@]\s*sourceMappingURL\s*=/u.test(comment.value.trim())
  );
  const finalLine = options.generatedSource.trimEnd().split(/\r?\n/u).at(-1);
  if (
    sourceMapReferences.length !== 1 ||
    sourceMapReferences[0]?.type !== "Line" ||
    sourceMapReferences[0]?.value.trim() !== "# sourceMappingURL=index.js.map" ||
    finalLine !== "//# sourceMappingURL=index.js.map"
  ) {
    return failure(
      "index.js must end with exactly one canonical sourceMappingURL for index.js.map.",
    );
  }

  return {
    ok: true,
    map: {
      version: 3,
      file: "index.js",
      sourceRoot: "",
      sources,
      sourcesContent: value.sourcesContent as string[],
      names: value.names as string[],
      mappings: value.mappings,
    },
  };
}

function decodeVlqSegment(segment: string): number[] | null {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64_DIGITS.indexOf(char);
    if (digit < 0) return null;
    const continuation = (digit & 32) !== 0;
    value += (digit & 31) << shift;
    if (continuation) {
      shift += 5;
      if (shift > 30) return null;
      continue;
    }
    const negative = (value & 1) === 1;
    const decoded = value >> 1;
    values.push(negative ? -decoded : decoded);
    value = 0;
    shift = 0;
  }
  return shift === 0 ? values : null;
}

function validateMappings(
  mappings: string,
  sourceCount: number,
  nameCount: number,
): string | null {
  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let previousName = 0;
  let meaningfulSegments = 0;

  for (const line of mappings.split(";")) {
    let previousGeneratedColumn = 0;
    if (line.length === 0) continue;
    for (const segmentText of line.split(",")) {
      if (segmentText.length === 0) return "index.js.map mappings contain an empty segment.";
      const fields = decodeVlqSegment(segmentText);
      if (fields === null || (fields.length !== 1 && fields.length !== 4 && fields.length !== 5)) {
        return "index.js.map mappings contain an invalid VLQ segment.";
      }
      previousGeneratedColumn += fields[0]!;
      if (previousGeneratedColumn < 0) {
        return "index.js.map mappings contain a negative generated column.";
      }
      if (fields.length === 1) continue;
      previousSource += fields[1]!;
      previousOriginalLine += fields[2]!;
      previousOriginalColumn += fields[3]!;
      if (
        previousSource < 0 ||
        previousSource >= sourceCount ||
        previousOriginalLine < 0 ||
        previousOriginalColumn < 0
      ) {
        return "index.js.map mappings reference an invalid source position.";
      }
      if (fields.length === 5) {
        previousName += fields[4]!;
        if (previousName < 0 || previousName >= nameCount) {
          return "index.js.map mappings reference an invalid name.";
        }
      }
      meaningfulSegments += 1;
    }
  }
  return meaningfulSegments > 0
    ? null
    : "index.js.map mappings must contain at least one mapped generated segment.";
}
