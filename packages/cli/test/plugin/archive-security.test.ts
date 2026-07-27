import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  ARTIFACT_SCHEMA_V1_LIMITS,
  validateArchiveExpansionMetrics,
} from "../../src/plugin/artifact-schema.ts";
import {
  buildNamedRootArchive,
  extractNamedRootArchive,
} from "../../src/plugin/archive.ts";

function writeTarString(target: Buffer, offset: number, value: string, length: number): void {
  Buffer.from(value, "utf8").copy(target, offset, 0, length);
}

function tarOctal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function rawHeader(options: {
  path: string;
  typeFlag?: string;
  bytes?: Buffer;
  linkName?: string;
}): Buffer {
  const bytes = options.bytes ?? Buffer.alloc(0);
  const header = Buffer.alloc(512, 0);
  let name = options.path;
  let prefix = "";
  if (Buffer.byteLength(name, "utf8") > 100) {
    const parts = name.split("/");
    let candidate = "";
    while (parts.length > 1) {
      const next = parts.shift()!;
      const trial = candidate.length === 0 ? next : `${candidate}/${next}`;
      if (Buffer.byteLength(trial, "utf8") > 155) break;
      candidate = trial;
      prefix = candidate;
      name = parts.join("/");
      if (Buffer.byteLength(name, "utf8") <= 100) break;
    }
  }
  writeTarString(header, 0, name, 100);
  writeTarString(header, 100, tarOctal(0o644, 8), 8);
  writeTarString(header, 108, tarOctal(0, 8), 8);
  writeTarString(header, 116, tarOctal(0, 8), 8);
  writeTarString(header, 124, tarOctal(bytes.byteLength, 12), 12);
  writeTarString(header, 136, tarOctal(0, 12), 12);
  writeTarString(header, 148, "        ", 8);
  writeTarString(header, 156, options.typeFlag ?? "0", 1);
  if (options.linkName !== undefined) writeTarString(header, 157, options.linkName, 100);
  writeTarString(header, 257, "ustar\0", 6);
  writeTarString(header, 263, "00", 2);
  if (prefix.length > 0) writeTarString(header, 345, prefix, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeTarString(header, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return header;
}

function rawArchive(
  entries: readonly { path: string; typeFlag?: string; bytes?: Buffer; linkName?: string }[],
  compressionLevel = 0,
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(0);
    chunks.push(rawHeader({ ...entry, bytes }), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: compressionLevel });
}

const IDENTITY = {
  id: "archive-security",
  version: "1.0.0",
  payloadSha256: "ab".repeat(32),
};

function expectArchiveFailure(
  archive: Buffer,
  expectedClass: string,
): void {
  const result = extractNamedRootArchive(archive);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected archive failure");
  expect(result.details?.entryClass ?? result.details?.limit).toBe(expectedClass);
}

describe("VAL-SDK-032 shared path and topology validation", () => {
  test("publishes one immutable V1 extraction limit set", () => {
    expect(ARTIFACT_SCHEMA_V1_LIMITS).toEqual({
      schemaVersion: 1,
      maxArchiveEntries: 256,
      maxNormalizedPathBytes: 100,
      maxFileUncompressedBytes: 16 * 1024 * 1024,
      maxTotalUncompressedBytes: 64 * 1024 * 1024,
      maxCompressionRatio: 200,
    });
    expect(Object.isFrozen(ARTIFACT_SCHEMA_V1_LIMITS)).toBe(true);
  });

  test("archive creation rejects unsafe paths and normalized collisions", () => {
    const build = (paths: readonly string[]) =>
      buildNamedRootArchive({
        ...IDENTITY,
        entries: paths.map((relativePath) => ({
          relativePath,
          bytes: Buffer.from(relativePath),
        })),
      });

    expect(() => build(["assets/Icon.png", "assets/icon.png"])).toThrow(/collid/i);
    expect(() => build(["assets/café.txt", "assets/cafe\u0301.txt"])).toThrow(/collid/i);
    expect(() => build(["assets", "assets/child.txt"])).toThrow(/descends|conflicts|topology/i);
    expect(() => build(["assets/Foo", "assets/foo/bar.js"])).toThrow(/normalized|descends|conflicts/i);
    expect(() => build(["assets/Foo/a.js", "assets/foo/b.js"])).toThrow(/normalized|collid/i);
    for (const path of [
      "../outside",
      "/absolute",
      "C:/drive",
      "assets\\backslash.txt",
      "assets//empty.txt",
      "assets/./dot.txt",
      "assets/control\n.txt",
    ]) {
      expect(() => build([path])).toThrow(/path|unsafe|control|drive|absolute/i);
    }
  });

  test("extraction rejects collision, escape, and hostile special entry classes", () => {
    const root = "archive-security-1.0.0-abababababababab";
    const cases: Array<{
      expected: string;
      entries: Array<{ path: string; typeFlag?: string; bytes?: Buffer; linkName?: string }>;
    }> = [
      {
        expected: "duplicate-path",
        entries: [
          { path: `${root}/index.js`, bytes: Buffer.from("a") },
          { path: `${root}/index.js`, bytes: Buffer.from("b") },
        ],
      },
      {
        expected: "normalized-collision",
        entries: [
          { path: `${root}/assets/Icon.png`, bytes: Buffer.from("a") },
          { path: `${root}/assets/icon.png`, bytes: Buffer.from("b") },
        ],
      },
      {
        expected: "normalized-collision",
        entries: [
          { path: `${root}/assets/café.txt`, bytes: Buffer.from("a") },
          { path: `${root}/assets/cafe\u0301.txt`, bytes: Buffer.from("b") },
        ],
      },
      {
        expected: "traversal",
        entries: [{ path: `${root}/../outside`, bytes: Buffer.from("x") }],
      },
      {
        expected: "backslash",
        entries: [{ path: `${root}/assets\\outside`, bytes: Buffer.from("x") }],
      },
      {
        expected: "absolute-path",
        entries: [{ path: "/absolute", bytes: Buffer.from("x") }],
      },
      {
        expected: "drive-like-path",
        entries: [{ path: "C:/drive", bytes: Buffer.from("x") }],
      },
      {
        expected: "symlink",
        entries: [{ path: `${root}/link`, typeFlag: "2", linkName: "../outside" }],
      },
      {
        expected: "hard-link",
        entries: [{ path: `${root}/hard`, typeFlag: "1", linkName: "../outside" }],
      },
      {
        expected: "character-device",
        entries: [{ path: `${root}/device`, typeFlag: "3" }],
      },
      {
        expected: "block-device",
        entries: [{ path: `${root}/block`, typeFlag: "4" }],
      },
      {
        expected: "fifo",
        entries: [{ path: `${root}/fifo`, typeFlag: "6" }],
      },
      {
        expected: "socket-or-special",
        entries: [{ path: `${root}/socket`, typeFlag: "7" }],
      },
      {
        expected: "file-directory-topology",
        entries: [
          { path: `${root}/assets`, bytes: Buffer.from("file") },
          { path: `${root}/assets/child.txt`, bytes: Buffer.from("child") },
        ],
      },
      {
        expected: "file-directory-topology",
        entries: [
          { path: `${root}/assets/Foo`, bytes: Buffer.from("file") },
          { path: `${root}/assets/foo/bar.js`, bytes: Buffer.from("child") },
        ],
      },
    ];

    for (const fixture of cases) {
      expectArchiveFailure(rawArchive(fixture.entries), fixture.expected);
    }
  });

  test("rejects corrupt headers and truncated containers", () => {
    const root = "archive-security-1.0.0-abababababababab";
    const valid = rawArchive([{ path: `${root}/index.js`, bytes: Buffer.from("x") }]);
    const corrupt = Buffer.from(valid);
    corrupt[20] ^= 0xff;
    const corruptResult = extractNamedRootArchive(corrupt);
    expect(corruptResult.ok).toBe(false);

    const truncated = valid.subarray(0, Math.floor(valid.byteLength / 2));
    const truncatedResult = extractNamedRootArchive(truncated);
    expect(truncatedResult.ok).toBe(false);
  });
});

describe("VAL-SDK-033 deterministic expansion limits", () => {
  test("accepts exact numeric limits and rejects one unit beyond", () => {
    const limits = ARTIFACT_SCHEMA_V1_LIMITS;
    expect(
      validateArchiveExpansionMetrics({
        entryCount: limits.maxArchiveEntries,
        normalizedPathBytes: limits.maxNormalizedPathBytes,
        fileUncompressedBytes: limits.maxFileUncompressedBytes,
        totalUncompressedBytes: limits.maxTotalUncompressedBytes,
        archiveBytes: Math.ceil(
          limits.maxTotalUncompressedBytes / limits.maxCompressionRatio,
        ),
      }).ok,
    ).toBe(true);

    for (const metrics of [
      { entryCount: limits.maxArchiveEntries + 1 },
      { normalizedPathBytes: limits.maxNormalizedPathBytes + 1 },
      { fileUncompressedBytes: limits.maxFileUncompressedBytes + 1 },
      { totalUncompressedBytes: limits.maxTotalUncompressedBytes + 1 },
    ]) {
      const result = validateArchiveExpansionMetrics({
        entryCount: metrics.entryCount ?? 1,
        normalizedPathBytes: metrics.normalizedPathBytes ?? 1,
        fileUncompressedBytes: metrics.fileUncompressedBytes ?? 1,
        totalUncompressedBytes: metrics.totalUncompressedBytes ?? 1,
        archiveBytes: 1,
        skipCompressionRatio: true,
      });
      expect(result.ok).toBe(false);
    }

    const ratioExceeded = validateArchiveExpansionMetrics({
      entryCount: 1,
      normalizedPathBytes: 1,
      fileUncompressedBytes: limits.maxCompressionRatio + 1,
      totalUncompressedBytes: limits.maxCompressionRatio + 1,
      archiveBytes: 1,
    });
    expect(ratioExceeded.ok).toBe(false);
    if (ratioExceeded.ok) throw new Error("expected ratio failure");
    expect(ratioExceeded.limit).toBe("compression-ratio");
  });

  test("archive parser enforces entry, path, file, total, and bomb limits", () => {
    const limits = ARTIFACT_SCHEMA_V1_LIMITS;
    const root = "archive-security-1.0.0-abababababababab";

    const exactEntries = Array.from({ length: limits.maxArchiveEntries }, (_, index) => ({
      path: `${root}/assets/f-${index.toString().padStart(3, "0")}`,
      bytes: Buffer.alloc(0),
    }));
    expect(extractNamedRootArchive(rawArchive(exactEntries)).ok).toBe(true);
    expectArchiveFailure(
      rawArchive([...exactEntries, { path: `${root}/assets/overflow`, bytes: Buffer.alloc(0) }]),
      "archive-entries",
    );

    const prefix = `${root}/assets/`;
    const relativePrefix = "assets/";
    const exactPath = `${prefix}${"p".repeat(limits.maxNormalizedPathBytes - Buffer.byteLength(relativePrefix))}`;
    expect(extractNamedRootArchive(rawArchive([{ path: exactPath, bytes: Buffer.alloc(0) }])).ok).toBe(true);
    expectArchiveFailure(
      rawArchive([{ path: `${exactPath}x`, bytes: Buffer.alloc(0) }]),
      "normalized-path-bytes",
    );

    const exactFile = randomBytes(limits.maxFileUncompressedBytes);
    expect(
      extractNamedRootArchive(
        rawArchive([{ path: `${root}/assets/exact.bin`, bytes: exactFile }]),
      ).ok,
    ).toBe(true);
    expectArchiveFailure(
      rawArchive([
        {
          path: `${root}/assets/over.bin`,
          bytes: Buffer.concat([exactFile, Buffer.from([1])]),
        },
      ]),
      "file-uncompressed-bytes",
    );

    const quarter = limits.maxTotalUncompressedBytes / 4;
    const exactTotalEntries = Array.from({ length: 4 }, (_, index) => ({
      path: `${root}/assets/total-${index}.bin`,
      bytes: randomBytes(quarter),
    }));
    expect(extractNamedRootArchive(rawArchive(exactTotalEntries)).ok).toBe(true);
    expectArchiveFailure(
      rawArchive([
        ...exactTotalEntries,
        { path: `${root}/assets/total-over.bin`, bytes: Buffer.from([1]) },
      ]),
      "total-uncompressed-bytes",
    );

    const bomb = rawArchive([
      {
        path: `${root}/assets/bomb.bin`,
        bytes: Buffer.alloc(1024 * 1024, 0),
      },
    ], 9);
    expectArchiveFailure(bomb, "compression-ratio");
    expectArchiveFailure(
      Buffer.concat([bomb, Buffer.alloc(1024 * 1024)]),
      "trailing-gzip-data",
    );
    expectArchiveFailure(
      Buffer.concat([bomb, gzipSync(Buffer.alloc(1024 * 1024), { level: 0 })]),
      "multiple-gzip-members",
    );

    expect(() =>
      buildNamedRootArchive({
        ...IDENTITY,
        entries: exactEntries.map((entry) => ({
          relativePath: entry.path.slice(root.length + 1),
          bytes: entry.bytes,
        })),
      }),
    ).toThrow(/entries|maximum/i);
  }, 300_000);
});
