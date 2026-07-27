/**
 * Canonical V1 plugin archive: gzip-compressed ustar with one named top-level
 * directory and only installable payload files beneath it.
 * archiveSha256 is SHA-256 of exact archive bytes (transport only).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import {
  ARTIFACT_SCHEMA_V1_LIMITS,
  validateArchiveExpansionMetrics,
} from "./artifact-schema.ts";
import {
  ArchiveTopologyTracker,
  validateArchivePath,
  type ArchiveEntryKind,
} from "./archive-path.ts";
import { compareBytewise, sha256Hex } from "./dist-files.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";

export type ArchiveFileEntry = {
  /** Path relative to the named archive root (posix, no leading slash). */
  relativePath: string;
  bytes: Buffer;
};

export type BuiltPluginArchive = {
  archiveBytes: Buffer;
  archiveSha256: string;
  payloadSha256: string;
  archiveRootName: string;
  archiveFileName: string;
  files: readonly string[];
};

export type ExtractedPluginArchive = {
  archiveRootName: string;
  /** Path → exact file bytes under the named root. */
  files: Map<string, Buffer>;
  archiveSha256: string;
};

export type ArchiveFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

const USTAR_MAGIC = "ustar";
const USTAR_VERSION = "00";
const ZERO_BLOCK_BYTES = 512;

function octal(value: number, length: number): string {
  const body = value.toString(8);
  if (body.length > length - 1) {
    throw new Error(`Octal field overflow: ${value}`);
  }
  return body.padStart(length - 1, "0") + "\0";
}

function writeString(target: Buffer, offset: number, value: string, length: number): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) {
    throw new Error(`Tar header field too long: ${value}`);
  }
  encoded.copy(target, offset);
}

function checksumHeader(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < ZERO_BLOCK_BYTES; index += 1) {
    sum += header[index]!;
  }
  return sum;
}

function buildUstarHeader(options: {
  name: string;
  size: number;
  typeFlag: string;
  mode: number;
}): Buffer {
  const header = Buffer.alloc(ZERO_BLOCK_BYTES, 0);
  let name = options.name;
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
    }
    if (Buffer.byteLength(name, "utf8") > 100 || Buffer.byteLength(prefix, "utf8") > 155) {
      throw new Error(`Archive path exceeds ustar limits: ${options.name}`);
    }
  }

  writeString(header, 0, name, 100);
  writeString(header, 100, octal(options.mode, 8), 8);
  writeString(header, 108, octal(0, 8), 8);
  writeString(header, 116, octal(0, 8), 8);
  writeString(header, 124, octal(options.size, 12), 12);
  writeString(header, 136, octal(0, 12), 12);
  writeString(header, 148, "        ", 8);
  writeString(header, 156, options.typeFlag, 1);
  writeString(header, 257, USTAR_MAGIC, 6);
  writeString(header, 263, USTAR_VERSION, 2);
  if (prefix.length > 0) writeString(header, 345, prefix, 155);

  const sum = checksumHeader(header);
  writeString(header, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return header;
}

function throwArchivePathFailure(message: string): never {
  throw new Error(message);
}

/** Build a deterministic gzip+ustar archive with one named root. */
export function buildNamedRootArchive(options: {
  id: string;
  version: string;
  payloadSha256: string;
  entries: readonly ArchiveFileEntry[];
}): BuiltPluginArchive {
  const identity = encodeArtifactIdentity(options);
  const sorted = [...options.entries].sort((a, b) =>
    compareBytewise(a.relativePath, b.relativePath),
  );
  const topology = new ArchiveTopologyTracker();
  const directoryTopology = new ArchiveTopologyTracker();
  const normalizedEntries: ArchiveFileEntry[] = [];
  const generatedDirectories = new Set<string>();
  let totalUncompressedBytes = 0;

  for (const entry of sorted) {
    const validated = validateArchivePath(entry.relativePath);
    if (!validated.ok) throwArchivePathFailure(validated.message);
    const topologyFailure = topology.add(validated.validated, "file");
    if (topologyFailure !== null) throwArchivePathFailure(topologyFailure.message);
    const parts = validated.validated.path.split("/");
    let directoryPrefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      directoryPrefix = directoryPrefix.length === 0
        ? parts[index]!
        : `${directoryPrefix}/${parts[index]!}`;
      if (!generatedDirectories.has(directoryPrefix)) {
        const validatedDirectory = validateArchivePath(directoryPrefix);
        if (!validatedDirectory.ok) throwArchivePathFailure(validatedDirectory.message);
        const directoryFailure = directoryTopology.add(validatedDirectory.validated, "directory");
        if (directoryFailure !== null) throwArchivePathFailure(directoryFailure.message);
        generatedDirectories.add(directoryPrefix);
      }
    }
    totalUncompressedBytes += entry.bytes.byteLength;
    const metrics = validateArchiveExpansionMetrics({
      entryCount: normalizedEntries.length + 1 + generatedDirectories.size,
      normalizedPathBytes: validated.validated.utf8Bytes,
      fileUncompressedBytes: entry.bytes.byteLength,
      totalUncompressedBytes,
      archiveBytes: 1,
      skipCompressionRatio: true,
    });
    if (!metrics.ok) throw new Error(metrics.message);
    normalizedEntries.push({
      relativePath: validated.validated.path,
      bytes: entry.bytes,
    });
  }

  const chunks: Buffer[] = [
    buildUstarHeader({
      name: `${identity.archiveRootName}/`,
      size: 0,
      typeFlag: "5",
      mode: 0o755,
    }),
  ];
  const directories = new Set<string>();
  for (const entry of normalizedEntries) {
    const parts = entry.relativePath.split("/");
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix.length === 0 ? parts[index]! : `${prefix}/${parts[index]!}`;
      if (!directories.has(prefix)) {
        directories.add(prefix);
        chunks.push(
          buildUstarHeader({
            name: `${identity.archiveRootName}/${prefix}/`,
            size: 0,
            typeFlag: "5",
            mode: 0o755,
          }),
        );
      }
    }
    chunks.push(
      buildUstarHeader({
        name: `${identity.archiveRootName}/${entry.relativePath}`,
        size: entry.bytes.byteLength,
        typeFlag: "0",
        mode: 0o644,
      }),
      entry.bytes,
    );
    const padding = (ZERO_BLOCK_BYTES - (entry.bytes.byteLength % ZERO_BLOCK_BYTES)) % ZERO_BLOCK_BYTES;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }

  chunks.push(Buffer.alloc(ZERO_BLOCK_BYTES * 2));
  const archiveBytes = gzipSync(Buffer.concat(chunks), { level: 9 });
  const archiveSha256 = sha256Hex(archiveBytes);
  return {
    archiveBytes,
    archiveSha256,
    payloadSha256: options.payloadSha256,
    archiveRootName: identity.archiveRootName,
    archiveFileName: identity.archiveFileName,
    files: normalizedEntries.map((entry) => entry.relativePath),
  };
}

function failure(
  message: string,
  details?: Record<string, unknown>,
  code = "plugin.artifact.invalid",
): ArchiveFailure {
  return { ok: false, code, message, details };
}

function readTarString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end < 0) end = slice.length;
  return Buffer.from(slice.subarray(0, end)).toString("utf8");
}

function parseStrictOctal(
  header: Buffer,
  start: number,
  length: number,
  fieldName: string,
): number | ArchiveFailure {
  const raw = readTarString(header, start, length).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    return failure(`Archive ${fieldName} field is not valid octal.`, {
      entryClass: "invalid-tar-number",
      field: fieldName,
    });
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return failure(`Archive ${fieldName} field is outside the supported range.`, {
      entryClass: "invalid-tar-number",
      field: fieldName,
    });
  }
  return parsed;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function singleGzipMemberLength(archiveBytes: Buffer): number | null {
  if (
    archiveBytes.byteLength < 18 ||
    archiveBytes[0] !== 0x1f ||
    archiveBytes[1] !== 0x8b ||
    archiveBytes[2] !== 0x08
  ) {
    return null;
  }
  const flags = archiveBytes[3]!;
  if ((flags & 0xe0) !== 0) return null;
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > archiveBytes.byteLength) return null;
    const extraLength = archiveBytes.readUInt16LE(offset);
    offset += 2 + extraLength;
  }
  for (const flag of [0x08, 0x10] as const) {
    if ((flags & flag) === 0) continue;
    while (offset < archiveBytes.byteLength && archiveBytes[offset] !== 0) offset += 1;
    offset += 1;
  }
  if ((flags & 0x02) !== 0) offset += 2;
  if (offset >= archiveBytes.byteLength) return null;
  try {
    const raw = inflateRawSync(archiveBytes.subarray(offset), {
      info: true,
      maxOutputLength:
        ARTIFACT_SCHEMA_V1_LIMITS.maxTotalUncompressedBytes +
        ARTIFACT_SCHEMA_V1_LIMITS.maxArchiveEntries * ZERO_BLOCK_BYTES * 2 +
        ZERO_BLOCK_BYTES * 2,
    }) as unknown as { engine: { bytesWritten: number } };
    return offset + raw.engine.bytesWritten + 8;
  } catch {
    return null;
  }
}

function classifyType(typeFlag: string, path: string):
  | { ok: true; kind: ArchiveEntryKind }
  | ArchiveFailure {
  if (typeFlag === "0" || typeFlag === "\0") return { ok: true, kind: "file" };
  if (typeFlag === "5") return { ok: true, kind: "directory" };
  const names: Record<string, string> = {
    "1": "hard-link",
    "2": "symlink",
    "3": "character-device",
    "4": "block-device",
    "6": "fifo",
    "7": "socket-or-special",
  };
  const entryClass = names[typeFlag] ?? "unsupported-entry-type";
  return failure(`Archive contains unsupported ${entryClass} entry: ${path}`, {
    entryClass,
    path,
    typeFlag,
  });
}

/**
 * Extract and validate a plugin archive entirely in memory.
 * No attacker-controlled path reaches the filesystem from this function.
 */
export function extractNamedRootArchive(
  archiveBytes: Buffer,
): { ok: true; extracted: ExtractedPluginArchive } | ArchiveFailure {
  const archiveSha256 = sha256Hex(archiveBytes);
  let tar: Buffer;
  let compressedMemberBytes: number;
  try {
    const decompressed = gunzipSync(archiveBytes, {
      info: true,
      maxOutputLength:
        ARTIFACT_SCHEMA_V1_LIMITS.maxTotalUncompressedBytes +
        ARTIFACT_SCHEMA_V1_LIMITS.maxArchiveEntries * ZERO_BLOCK_BYTES * 2 +
        ZERO_BLOCK_BYTES * 2,
    }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    tar = decompressed.buffer;
    compressedMemberBytes = decompressed.engine.bytesWritten;
    const firstMemberBytes = singleGzipMemberLength(archiveBytes);
    if (firstMemberBytes === null) {
      return failure("Archive gzip member is malformed.", {
        entryClass: "invalid-gzip",
      });
    }
    if (firstMemberBytes !== archiveBytes.byteLength) {
      const trailingIsGzip =
        archiveBytes[firstMemberBytes] === 0x1f &&
        archiveBytes[firstMemberBytes + 1] === 0x8b &&
        archiveBytes[firstMemberBytes + 2] === 0x08;
      return failure(
        trailingIsGzip
          ? "Archive must contain exactly one gzip member."
          : "Archive contains trailing bytes after the gzip member.",
        {
          entryClass: trailingIsGzip ? "multiple-gzip-members" : "trailing-gzip-data",
          firstMemberBytes,
          archiveBytes: archiveBytes.byteLength,
        },
      );
    }
    compressedMemberBytes = firstMemberBytes;
  } catch {
    return failure("Archive is not valid bounded gzip.", {
      entryClass: "invalid-gzip",
    });
  }

  const files = new Map<string, Buffer>();
  const topology = new ArchiveTopologyTracker();
  const seenDirectories = new Set<string>();
  let archiveRootName: string | null = null;
  let rootCollisionKey: string | null = null;
  let installableEntryCount = 0;
  let totalUncompressedBytes = 0;
  let offset = 0;
  let foundTerminator = false;

  while (offset + ZERO_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + ZERO_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      if (offset + ZERO_BLOCK_BYTES * 2 > tar.byteLength) {
        return failure("Archive is missing the second zero terminator block.", {
          entryClass: "truncated-container",
        });
      }
      const second = tar.subarray(offset + ZERO_BLOCK_BYTES, offset + ZERO_BLOCK_BYTES * 2);
      if (!isZeroBlock(second)) {
        return failure("Archive terminator is malformed.", {
          entryClass: "invalid-terminator",
        });
      }
      const trailing = tar.subarray(offset + ZERO_BLOCK_BYTES * 2);
      if (!trailing.every((byte) => byte === 0)) {
        return failure("Archive contains non-zero trailing bytes.", {
          entryClass: "trailing-data",
        });
      }
      foundTerminator = true;
      break;
    }

    const storedChecksum = parseStrictOctal(header, 148, 8, "checksum");
    if (typeof storedChecksum !== "number") return storedChecksum;
    const checksumCopy = Buffer.from(header);
    checksumCopy.fill(0x20, 148, 156);
    if (checksumHeader(checksumCopy) !== storedChecksum) {
      return failure("Archive header checksum is invalid.", {
        entryClass: "invalid-header-checksum",
      });
    }
    if (
      readTarString(header, 257, 6) !== USTAR_MAGIC ||
      readTarString(header, 263, 2) !== USTAR_VERSION
    ) {
      return failure("Archive entry is not canonical ustar.", {
        entryClass: "invalid-ustar-header",
      });
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const full = prefix.length > 0 ? `${prefix}/${name}` : name;
    const validatedFull = validateArchivePath(full, { maxUtf8Bytes: null });
    if (!validatedFull.ok) {
      return failure(validatedFull.message, {
        entryClass: validatedFull.entryClass,
        path: full,
      });
    }
    const size = parseStrictOctal(header, 124, 12, "size");
    if (typeof size !== "number") return size;
    const typeByte = header[156] ?? 0;
    const typeFlag = typeByte === 0 ? "\0" : String.fromCharCode(typeByte);
    const type = classifyType(typeFlag, full);
    if (!type.ok) return type;
    if (type.kind === "directory" && size !== 0) {
      return failure(`Archive directory has non-zero size: ${full}`, {
        entryClass: "directory-with-data",
        path: full,
      });
    }

    const relativeComponents = validatedFull.validated.components.slice(1);
    const normalizedRelative = relativeComponents.join("/");
    const isRootDirectory = type.kind === "directory" && relativeComponents.length === 0;
    const countsAsInstallableEntry = type.kind === "file" ||
      (type.kind === "directory" && !isRootDirectory && !seenDirectories.has(normalizedRelative));
    if (countsAsInstallableEntry) installableEntryCount += 1;
    const nextTotal = totalUncompressedBytes + (type.kind === "file" ? size : 0);
    const metrics = validateArchiveExpansionMetrics({
      entryCount: installableEntryCount,
      normalizedPathBytes: normalizedRelative.length === 0
        ? 0
        : Buffer.byteLength(normalizedRelative, "utf8"),
      fileUncompressedBytes: type.kind === "file" ? size : 0,
      totalUncompressedBytes: nextTotal,
      archiveBytes: archiveBytes.byteLength,
      skipCompressionRatio: true,
    });
    if (!metrics.ok) {
      return failure(metrics.message, {
        entryClass: metrics.limit,
        limit: metrics.limit,
        maximum: metrics.maximum,
        actual: metrics.actual,
        path: full,
      });
    }

    const root = validatedFull.validated.components[0]!;
    const rootKey = root.normalize("NFC").toLocaleLowerCase("en-US");
    if (archiveRootName === null) {
      archiveRootName = root;
      rootCollisionKey = rootKey;
    } else if (root !== archiveRootName) {
      return failure("Archive has multiple top-level directories.", {
        entryClass: rootCollisionKey === rootKey ? "normalized-collision" : "multiple-roots",
        roots: [archiveRootName, root],
      });
    }

    const dataStart = offset + ZERO_BLOCK_BYTES;
    const dataBlocks = Math.ceil(size / ZERO_BLOCK_BYTES);
    const next = dataStart + dataBlocks * ZERO_BLOCK_BYTES;
    if (next > tar.byteLength) {
      return failure(`Archive entry is truncated: ${full}`, {
        entryClass: "truncated-entry",
        path: full,
      });
    }

    if (relativeComponents.length === 0) {
      if (type.kind !== "directory") {
        return failure("Archive must not contain root-level payload files.", {
          entryClass: "root-level-file",
          path: full,
        });
      }
    } else {
      const relativeResult = validateArchivePath(normalizedRelative);
      if (!relativeResult.ok) {
        return failure(relativeResult.message, {
          entryClass: relativeResult.entryClass,
          path: normalizedRelative,
        });
      }
      const topologyFailure = topology.add(relativeResult.validated, type.kind);
      if (topologyFailure !== null) {
        return failure(topologyFailure.message, {
          entryClass: topologyFailure.entryClass,
          path: topologyFailure.path,
        });
      }
      if (type.kind === "directory") seenDirectories.add(relativeResult.validated.path);
      if (type.kind === "file") {
        files.set(relativeResult.validated.path, Buffer.from(tar.subarray(dataStart, dataStart + size)));
        totalUncompressedBytes = nextTotal;
      }
    }
    offset = next;
  }

  if (!foundTerminator) {
    return failure("Archive is missing its two-block terminator.", {
      entryClass: "truncated-container",
    });
  }
  if (archiveRootName === null || files.size === 0) {
    return failure("Archive has no installable payload files.", {
      entryClass: "empty-payload",
    });
  }
  const finalMetrics = validateArchiveExpansionMetrics({
    entryCount: installableEntryCount,
    normalizedPathBytes: 0,
    fileUncompressedBytes: 0,
    totalUncompressedBytes,
    archiveBytes: compressedMemberBytes,
  });
  if (!finalMetrics.ok) {
    return failure(finalMetrics.message, {
      entryClass: finalMetrics.limit,
      limit: finalMetrics.limit,
      maximum: finalMetrics.maximum,
      actual: finalMetrics.actual,
    });
  }

  return {
    ok: true,
    extracted: {
      archiveRootName,
      files,
      archiveSha256,
    },
  };
}

export async function writeArchiveFile(
  destinationPath: string,
  archiveBytes: Buffer,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const staging = `${destinationPath}.tmp-${process.pid}`;
  await writeFile(staging, archiveBytes);
  const { rename, rm } = await import("node:fs/promises");
  try {
    await rename(staging, destinationPath);
  } catch {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    await rename(staging, destinationPath);
  }
}

export async function loadPayloadEntries(
  payloadDir: string,
  relativePaths: readonly string[],
): Promise<ArchiveFileEntry[]> {
  const entries: ArchiveFileEntry[] = [];
  for (const relative of relativePaths) {
    const bytes = await readFile(join(payloadDir, relative));
    entries.push({ relativePath: relative, bytes });
  }
  return entries;
}

export function computeArchiveSha256(archiveBytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(archiveBytes).digest("hex");
}
