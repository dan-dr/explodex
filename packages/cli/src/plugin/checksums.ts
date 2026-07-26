/**
 * Per-file checksums.json and archive-independent payloadSha256.
 * payloadSha256 algorithm is frozen for installable payload identity.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareBytewise,
  listInstallableFiles,
  sha256Hex,
} from "./dist-files.ts";

export type ChecksumRecord = {
  sha256: string;
  bytes: number;
};

export type ChecksumsManifest = {
  schemaVersion: 1;
  files: Record<string, ChecksumRecord>;
};

export async function buildChecksumsFromDir(stagingDir: string): Promise<ChecksumsManifest> {
  const files = await listInstallableFiles(stagingDir);
  // Exclude checksums.json itself while building.
  const targets = files.filter((relative) => relative !== "checksums.json");
  const records: Record<string, ChecksumRecord> = {};
  for (const relative of targets.sort(compareBytewise)) {
    const bytes = await readFile(join(stagingDir, relative));
    records[relative] = {
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }
  return {
    schemaVersion: 1,
    files: records,
  };
}

export function serializeChecksums(manifest: ChecksumsManifest): string {
  // Stable nested key order: schemaVersion then files with sorted path keys.
  const orderedFiles: Record<string, ChecksumRecord> = {};
  for (const path of Object.keys(manifest.files).sort(compareBytewise)) {
    const record = manifest.files[path]!;
    orderedFiles[path] = {
      sha256: record.sha256,
      bytes: record.bytes,
    };
  }
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      files: orderedFiles,
    },
    null,
    2,
  )}\n`;
}

export async function writeChecksums(stagingDir: string, manifest: ChecksumsManifest): Promise<string> {
  const text = serializeChecksums(manifest);
  await writeFile(join(stagingDir, "checksums.json"), text, "utf8");
  return text;
}

export async function readChecksums(distPath: string): Promise<ChecksumsManifest> {
  const raw = JSON.parse(await readFile(join(distPath, "checksums.json"), "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("checksums.json must be an object");
  }
  const value = raw as { schemaVersion?: unknown; files?: unknown };
  if (value.schemaVersion !== 1) {
    throw new Error("checksums.json schemaVersion must be 1");
  }
  if (value.files === null || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error("checksums.json files must be an object");
  }
  const files: Record<string, ChecksumRecord> = {};
  for (const [path, record] of Object.entries(value.files as Record<string, unknown>)) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`checksums.json record invalid for ${path}`);
    }
    const entry = record as { sha256?: unknown; bytes?: unknown };
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`checksums.json sha256 invalid for ${path}`);
    }
    if (typeof entry.bytes !== "number" || !Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`checksums.json bytes invalid for ${path}`);
    }
    files[path] = { sha256: entry.sha256, bytes: entry.bytes };
  }
  return { schemaVersion: 1, files };
}

/**
 * Canonical archive-independent payload identity.
 * Domain-separated UTF-8 serialization over sorted checksum records.
 */
export function computePayloadSha256(manifest: ChecksumsManifest): string {
  const parts: Buffer[] = [Buffer.from("explodex-payload-v1\0", "utf8")];
  for (const path of Object.keys(manifest.files).sort(compareBytewise)) {
    if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
      throw new Error(`Invalid path in checksums for payload digest: ${JSON.stringify(path)}`);
    }
    const record = manifest.files[path]!;
    const byteCount = String(record.bytes);
    if (!/^(0|[1-9][0-9]*)$/.test(byteCount)) {
      throw new Error(`Invalid byte count for payload digest at ${path}`);
    }
    parts.push(Buffer.from(path, "utf8"));
    parts.push(Buffer.from("\0", "utf8"));
    parts.push(Buffer.from(byteCount, "utf8"));
    parts.push(Buffer.from("\0", "utf8"));
    parts.push(Buffer.from(record.sha256, "utf8"));
    parts.push(Buffer.from("\n", "utf8"));
  }
  return sha256Hex(Buffer.concat(parts));
}

/** Verify every installable file (except checksums.json) matches checksums records. */
export async function verifyDistAgainstChecksums(
  distPath: string,
  manifest: ChecksumsManifest,
): Promise<{ ok: true } | { ok: false; message: string; path?: string }> {
  const installable = (await listInstallableFiles(distPath)).filter(
    (relative) => relative !== "checksums.json",
  );
  const expected = new Set(Object.keys(manifest.files));
  const actual = new Set(installable);

  for (const path of actual) {
    if (!expected.has(path)) {
      return { ok: false, message: `Installable file missing from checksums.json: ${path}`, path };
    }
  }
  for (const path of expected) {
    if (!actual.has(path)) {
      return { ok: false, message: `checksums.json lists missing file: ${path}`, path };
    }
    const bytes = await readFile(join(distPath, path));
    const record = manifest.files[path]!;
    if (bytes.byteLength !== record.bytes) {
      return {
        ok: false,
        message: `Byte count mismatch for ${path}`,
        path,
      };
    }
    if (sha256Hex(bytes) !== record.sha256) {
      return {
        ok: false,
        message: `SHA-256 mismatch for ${path}`,
        path,
      };
    }
  }
  return { ok: true };
}
