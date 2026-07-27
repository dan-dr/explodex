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
import {
  PayloadPathTopologyTracker,
  validateNormalizedPayloadPath,
} from "./payload-path.ts";

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
  const records: Record<string, ChecksumRecord> = Object.create(null) as Record<
    string,
    ChecksumRecord
  >;
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
  validateChecksumsManifest(manifest);
  // Stable nested key order: schemaVersion then files with sorted path keys.
  const orderedFiles: Record<string, ChecksumRecord> = Object.create(null) as Record<
    string,
    ChecksumRecord
  >;
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
  return parseChecksumsJson(await readFile(join(distPath, "checksums.json"), "utf8"));
}

export function parseChecksumsJson(text: string): ChecksumsManifest {
  detectDuplicateDecodedObjectKeys(text);
  const raw = JSON.parse(text) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("checksums.json must be an object");
  }
  const value = raw as Record<string, unknown>;
  if (!hasExactKeys(value, ["schemaVersion", "files"])) {
    throw new Error("checksums.json has unexpected or missing fields");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("checksums.json schemaVersion must be 1");
  }
  if (value.files === null || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error("checksums.json files must be an object");
  }
  const files: Record<string, ChecksumRecord> = Object.create(null) as Record<
    string,
    ChecksumRecord
  >;
  for (const [path, record] of Object.entries(value.files as Record<string, unknown>)) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`checksums.json record invalid for ${path}`);
    }
    const entry = record as Record<string, unknown>;
    if (!hasExactKeys(entry, ["sha256", "bytes"])) {
      throw new Error(`checksums.json record has unexpected or missing fields for ${path}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`checksums.json sha256 invalid for ${path}`);
    }
    if (typeof entry.bytes !== "number" || !Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`checksums.json bytes invalid for ${path}`);
    }
    files[path] = { sha256: entry.sha256, bytes: entry.bytes };
  }
  const manifest: ChecksumsManifest = { schemaVersion: 1, files };
  validateChecksumsManifest(manifest);
  return manifest;
}

/**
 * Canonical archive-independent payload identity.
 * Domain-separated UTF-8 serialization over sorted checksum records.
 */
export function computePayloadSha256(manifest: ChecksumsManifest): string {
  validateChecksumsManifest(manifest);
  const parts: Buffer[] = [Buffer.from("explodex-payload-v1\0", "utf8")];
  for (const path of Object.keys(manifest.files).sort(compareBytewise)) {
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

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort(compareBytewise);
  const expectedKeys = [...expected].sort(compareBytewise);
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]);
}

function validateChecksumsManifest(manifest: ChecksumsManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new Error("checksums.json schemaVersion must be 1");
  }
  const topology = new PayloadPathTopologyTracker();
  for (const path of Object.keys(manifest.files).sort(compareBytewise)) {
    const validated = validateNormalizedPayloadPath(path, { kind: "file" });
    if (!validated.ok) throw new Error(validated.message);
    const topologyFailure = topology.addFileWithImplicitDirectories(validated.validated);
    if (topologyFailure !== null) throw new Error(topologyFailure.message);
    const record = manifest.files[path]!;
    if (!/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(`checksums.json sha256 invalid for ${path}`);
    }
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new Error(`checksums.json bytes invalid for ${path}`);
    }
  }
}

function detectDuplicateDecodedObjectKeys(text: string): void {
  try {
    new JsonDuplicateKeyScanner(text).scan();
  } catch (error: unknown) {
    if (error instanceof DuplicateJsonKeyError) throw error;
  }
}

class DuplicateJsonKeyError extends Error {}

class JsonDuplicateKeyScanner {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  scan(): void {
    this.#skipWhitespace();
    this.#scanValue();
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) throw new Error("trailing JSON data");
  }

  #scanValue(): void {
    this.#skipWhitespace();
    const current = this.#text[this.#index];
    if (current === "{") {
      this.#scanObject();
      return;
    }
    if (current === "[") {
      this.#scanArray();
      return;
    }
    if (current === '"') {
      this.#scanString();
      return;
    }
    if (current === undefined) throw new Error("missing JSON value");
    while (this.#index < this.#text.length) {
      const char = this.#text[this.#index]!;
      if (char === "," || char === "]" || char === "}" || /\s/u.test(char)) break;
      this.#index += 1;
    }
  }

  #scanObject(): void {
    this.#index += 1;
    const seen = new Set<string>();
    this.#skipWhitespace();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    while (this.#index < this.#text.length) {
      this.#skipWhitespace();
      const key = this.#scanString();
      if (seen.has(key)) {
        throw new DuplicateJsonKeyError(
          `checksums.json contains duplicate decoded key: ${key}`,
        );
      }
      seen.add(key);
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ":") throw new Error("missing JSON colon");
      this.#index += 1;
      this.#scanValue();
      this.#skipWhitespace();
      const delimiter = this.#text[this.#index];
      if (delimiter === "}") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") throw new Error("missing JSON object delimiter");
      this.#index += 1;
    }
    throw new Error("unterminated JSON object");
  }

  #scanArray(): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    while (this.#index < this.#text.length) {
      this.#scanValue();
      this.#skipWhitespace();
      const delimiter = this.#text[this.#index];
      if (delimiter === "]") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") throw new Error("missing JSON array delimiter");
      this.#index += 1;
    }
    throw new Error("unterminated JSON array");
  }

  #scanString(): string {
    const start = this.#index;
    if (this.#text[this.#index] !== '"') throw new Error("JSON key must be a string");
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const char = this.#text[this.#index]!;
      if (char === '"') {
        this.#index += 1;
        return JSON.parse(this.#text.slice(start, this.#index)) as string;
      }
      if (char === "\\") {
        this.#index += 1;
        if (this.#text[this.#index] === "u") this.#index += 4;
      }
      this.#index += 1;
    }
    throw new Error("unterminated JSON string");
  }

  #skipWhitespace(): void {
    while (
      this.#index < this.#text.length &&
      /[\u0009\u000a\u000d\u0020]/u.test(this.#text[this.#index]!)
    ) {
      this.#index += 1;
    }
  }
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
