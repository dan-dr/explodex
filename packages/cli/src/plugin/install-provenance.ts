import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactSource } from "./install-state.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ArtifactProvenanceRecord = {
  schemaVersion: 1;
  id: string;
  version: string;
  payloadSha256: string;
  archiveSha256: string;
  installedDirectoryName: string;
  source: ArtifactSource;
  installedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function parseArtifactProvenance(value: unknown): ArtifactProvenanceRecord | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    "archiveSha256",
    "id",
    "installedAt",
    "installedDirectoryName",
    "payloadSha256",
    "schemaVersion",
    "source",
    "version",
  ].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    return null;
  }
  if (value.schemaVersion !== 1 || typeof value.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) || typeof value.version !== "string" ||
    value.version.length === 0 || typeof value.payloadSha256 !== "string" ||
    !SHA256_PATTERN.test(value.payloadSha256) || typeof value.archiveSha256 !== "string" ||
    !SHA256_PATTERN.test(value.archiveSha256) || typeof value.installedDirectoryName !== "string" ||
    value.installedDirectoryName.length === 0 || !isIsoTimestamp(value.installedAt) ||
    !isRecord(value.source) || value.source.kind !== "local" ||
    typeof value.source.archiveName !== "string" || value.source.archiveName.length === 0) {
    return null;
  }
  return {
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    payloadSha256: value.payloadSha256,
    archiveSha256: value.archiveSha256,
    installedDirectoryName: value.installedDirectoryName,
    source: { kind: "local", archiveName: value.source.archiveName },
    installedAt: value.installedAt,
  };
}

export function artifactProvenancePath(options: {
  explodexHome: string;
  id: string;
  installedDirectoryName: string;
}): string {
  return join(
    options.explodexHome,
    "plugins",
    options.id,
    ".provenance",
    `${options.installedDirectoryName}.json`,
  );
}

export async function loadArtifactProvenance(options: {
  explodexHome: string;
  id: string;
  installedDirectoryName: string;
}): Promise<ArtifactProvenanceRecord | null> {
  try {
    const text = await readFile(artifactProvenancePath(options), "utf8");
    return parseArtifactProvenance(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export async function saveArtifactProvenanceOnce(options: {
  explodexHome: string;
  record: ArtifactProvenanceRecord;
}): Promise<void> {
  const parsed = parseArtifactProvenance(options.record);
  if (parsed === null) throw new Error("Refusing to persist malformed artifact provenance.");
  const finalPath = artifactProvenancePath({
    explodexHome: options.explodexHome,
    id: parsed.id,
    installedDirectoryName: parsed.installedDirectoryName,
  });
  try {
    const existing = parseArtifactProvenance(JSON.parse(await readFile(finalPath, "utf8")) as unknown);
    if (existing === null || existing.id !== parsed.id || existing.version !== parsed.version ||
      existing.payloadSha256 !== parsed.payloadSha256) {
      throw new Error("Existing artifact provenance conflicts with the immutable identity.");
    }
    return;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("conflicts")) throw error;
  }

  const parent = dirname(finalPath);
  const tempPath = join(parent, `.provenance-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(parent, PRIVATE_DIRECTORY_MODE);
  let handle = null as Awaited<ReturnType<typeof open>> | null;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(tempPath, finalPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      const winner = parseArtifactProvenance(JSON.parse(await readFile(finalPath, "utf8")) as unknown);
      if (winner === null || winner.id !== parsed.id || winner.version !== parsed.version ||
        winner.payloadSha256 !== parsed.payloadSha256) {
        throw new Error("Concurrent artifact provenance conflicts with the immutable identity.");
      }
    }
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}
