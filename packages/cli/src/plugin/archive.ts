/**
 * Canonical V1 plugin archive: gzip-compressed ustar with one named top-level
 * directory and only installable payload files beneath it.
 * archiveSha256 is SHA-256 of exact archive bytes (transport only).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { compareBytewise, sha256Hex } from "./dist-files.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";

export type ArchiveFileEntry = {
  /** Path relative to the named archive root (posix, no leading slash). */
  relativePath: string;
  bytes: Buffer;
};

export type BuiltPluginArchive = {
  /** Exact archive bytes written / to be written. */
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

const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";

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
  for (let i = 0; i < 512; i += 1) {
    sum += header[i]!;
  }
  return sum;
}

function buildUstarHeader(options: {
  name: string;
  size: number;
  typeFlag: string;
  mode: number;
}): Buffer {
  const header = Buffer.alloc(512, 0);
  let name = options.name;
  let prefix = "";
  if (Buffer.byteLength(name, "utf8") > 100) {
    // Split into prefix/name for paths longer than 100 bytes.
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
  writeString(header, 108, octal(0, 8), 8); // uid
  writeString(header, 116, octal(0, 8), 8); // gid
  writeString(header, 124, octal(options.size, 12), 12);
  writeString(header, 136, octal(0, 12), 12); // mtime = 0 for determinism
  // checksum field temporarily spaces
  writeString(header, 148, "        ", 8);
  writeString(header, 156, options.typeFlag, 1);
  writeString(header, 257, USTAR_MAGIC, 6);
  writeString(header, 263, USTAR_VERSION, 2);
  if (prefix.length > 0) {
    writeString(header, 345, prefix, 155);
  }

  const sum = checksumHeader(header);
  // 6-digit octal + NUL + space (common portable form)
  const checksumField = `${sum.toString(8).padStart(6, "0")}\0 `;
  writeString(header, 148, checksumField, 8);
  return header;
}

/**
 * Build a deterministic gzip+ustar archive with exactly one named top-level
 * directory and no root-level payload files.
 */
export function buildNamedRootArchive(options: {
  id: string;
  version: string;
  payloadSha256: string;
  entries: readonly ArchiveFileEntry[];
}): BuiltPluginArchive {
  const identity = encodeArtifactIdentity({
    id: options.id,
    version: options.version,
    payloadSha256: options.payloadSha256,
  });

  const sorted = [...options.entries].sort((a, b) =>
    compareBytewise(a.relativePath, b.relativePath),
  );
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (entry.relativePath.length === 0) {
      throw new Error("Archive entry path must not be empty.");
    }
    if (
      entry.relativePath.startsWith("/") ||
      entry.relativePath.includes("\\") ||
      entry.relativePath.includes("\0") ||
      entry.relativePath.split("/").includes("..") ||
      entry.relativePath.split("/").includes("")
    ) {
      throw new Error(`Invalid archive entry path: ${entry.relativePath}`);
    }
    if (seen.has(entry.relativePath)) {
      throw new Error(`Duplicate archive entry: ${entry.relativePath}`);
    }
    seen.add(entry.relativePath);
  }

  const chunks: Buffer[] = [];
  // Directory entry for the named root.
  chunks.push(
    buildUstarHeader({
      name: `${identity.archiveRootName}/`,
      size: 0,
      typeFlag: "5",
      mode: 0o755,
    }),
  );

  const dirs = new Set<string>();
  for (const entry of sorted) {
    const parts = entry.relativePath.split("/");
    if (parts.length > 1) {
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i += 1) {
        prefix = prefix.length === 0 ? parts[i]! : `${prefix}/${parts[i]!}`;
        if (!dirs.has(prefix)) {
          dirs.add(prefix);
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
    }
    const fullName = `${identity.archiveRootName}/${entry.relativePath}`;
    chunks.push(
      buildUstarHeader({
        name: fullName,
        size: entry.bytes.byteLength,
        typeFlag: "0",
        mode: 0o644,
      }),
    );
    chunks.push(entry.bytes);
    const pad = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad, 0));
    }
  }

  // Two zero blocks end the archive.
  chunks.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(chunks);
  // mtime/OS fields in gzip are zeroed by using gzipSync defaults with level.
  const archiveBytes = gzipSync(tar, { level: 9 });
  const archiveSha256 = sha256Hex(archiveBytes);

  return {
    archiveBytes,
    archiveSha256,
    payloadSha256: options.payloadSha256,
    archiveRootName: identity.archiveRootName,
    archiveFileName: identity.archiveFileName,
    files: sorted.map((entry) => entry.relativePath),
  };
}

function readTarString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end < 0) end = slice.length;
  return Buffer.from(slice.subarray(0, end)).toString("utf8");
}

function parseOctal(value: string): number {
  const trimmed = value.replace(/\0/g, "").trim();
  if (trimmed.length === 0) return 0;
  return Number.parseInt(trimmed, 8) || 0;
}

/**
 * Extract and validate topology of a plugin archive.
 * Rejects flat-root payloads, multiple top-level roots, and non-file/dir types.
 */
export function extractNamedRootArchive(
  archiveBytes: Buffer,
):
  | { ok: true; extracted: ExtractedPluginArchive }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> } {
  const archiveSha256 = sha256Hex(archiveBytes);
  let tar: Buffer;
  try {
    tar = gunzipSync(archiveBytes);
  } catch {
    return {
      ok: false,
      code: "plugin.artifact.invalid",
      message: "Archive is not valid gzip.",
    };
  }

  const files = new Map<string, Buffer>();
  let archiveRootName: string | null = null;
  let offset = 0;

  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const full = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = parseOctal(readTarString(header, 124, 12));
    const typeFlag = String.fromCharCode(header[156] ?? 0) || "0";
    const dataStart = offset + 512;
    const dataBlocks = Math.ceil(size / 512);
    const next = dataStart + dataBlocks * 512;

    if (full.length === 0) {
      offset = next;
      continue;
    }

    const normalized = full.replace(/\/+$/, "");
    const parts = normalized.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) {
      return {
        ok: false,
        code: "plugin.artifact.invalid",
        message: "Archive contains an empty path entry.",
      };
    }
    const root = parts[0]!;
    if (archiveRootName === null) {
      archiveRootName = root;
    } else if (root !== archiveRootName) {
      return {
        ok: false,
        code: "plugin.artifact.invalid",
        message: "Archive has multiple top-level directories.",
        details: { roots: [archiveRootName, root] },
      };
    }

    // Reject non-regular, non-directory entries.
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "5") {
      return {
        ok: false,
        code: "plugin.artifact.invalid",
        message: `Archive contains unsupported entry type '${typeFlag}' for ${full}`,
        details: { path: full, typeFlag },
      };
    }

    if (typeFlag === "5" || full.endsWith("/")) {
      // Directory only.
      offset = next;
      continue;
    }

    if (parts.length === 1) {
      return {
        ok: false,
        code: "plugin.artifact.invalid",
        message: "Archive must not contain root-level payload files.",
        details: { path: full },
      };
    }

    const relative = parts.slice(1).join("/");
    if (
      relative.includes("\\") ||
      relative.includes("\0") ||
      relative.split("/").includes("..")
    ) {
      return {
        ok: false,
        code: "plugin.artifact.invalid",
        message: `Archive entry path is unsafe: ${relative}`,
        details: { path: relative },
      };
    }

    const data = Buffer.from(tar.subarray(dataStart, dataStart + size));
    if (files.has(relative)) {
      return {
        ok: false,
        code: "plugin.artifact.invalid",
        message: `Archive contains duplicate path: ${relative}`,
        details: { path: relative },
      };
    }
    files.set(relative, data);
    offset = next;
  }

  if (archiveRootName === null || files.size === 0) {
    return {
      ok: false,
      code: "plugin.artifact.invalid",
      message: "Archive has no installable payload files.",
    };
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
  // Private staging sibling then rename for atomic publish of the archive file.
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

/** Load installable files from a payload directory into archive entries. */
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
