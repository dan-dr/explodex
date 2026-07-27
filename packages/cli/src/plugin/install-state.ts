import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pluginsStatePath } from "../home/paths.ts";

export const PLUGINS_STATE_SCHEMA_VERSION = 1 as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ARCHIVE_NAME_BYTES = 255;

type ArtifactIdentity = {
  version: string;
  payloadSha256: string;
};

export type LocalArtifactSource = {
  kind: "local";
  archiveName: string;
};

export type RegistryArtifactSource = {
  kind: "registry";
  registryUrl: string;
  repositoryUrl: string;
  artifactUrl: string;
};

export type GitHubArtifactSource = {
  kind: "github";
  repositoryUrl: string;
  artifactUrl: string;
  expectedArchiveSha256: string;
};

export type ArtifactSource =
  | LocalArtifactSource
  | RegistryArtifactSource
  | GitHubArtifactSource;

export type InstalledArtifact = ArtifactIdentity & {
  archiveSha256: string;
  relativePath: string;
  source: ArtifactSource;
  installedAt: string;
};

export type PluginStateRecord = {
  installed: InstalledArtifact[];
  enabled: ArtifactIdentity | null;
  pendingReview: ArtifactIdentity[];
};

export type PluginsState = {
  schemaVersion: typeof PLUGINS_STATE_SCHEMA_VERSION;
  plugins: Record<string, PluginStateRecord>;
  updatedAt: string;
};

export type PluginsStateLoadResult =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "valid"; state: PluginsState };

export type PluginsStateWriteAdapters = {
  beforeSerialize?(): void | Promise<void>;
  beforeTempWrite?(): void | Promise<void>;
  beforeTempSync?(): void | Promise<void>;
  beforeRename?(): void | Promise<void>;
  beforeDirectorySync?(): void | Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !/[\u0000-\u001f\u007f/\\]/u.test(value) && value !== "." && value !== "..";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function parseIdentity(value: unknown): ArtifactIdentity | null {
  if (!isRecord(value) || !exactKeys(value, ["version", "payloadSha256"])) return null;
  if (!isSafeVersion(value.version) || typeof value.payloadSha256 !== "string" ||
    !SHA256_PATTERN.test(value.payloadSha256)) return null;
  return { version: value.version, payloadSha256: value.payloadSha256 };
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" &&
      parsed.password === "";
  } catch {
    return false;
  }
}

export function parseArtifactSource(value: unknown): ArtifactSource | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "local") {
    if (
      !exactKeys(value, ["kind", "archiveName"]) ||
      typeof value.archiveName !== "string" ||
      !isSafeLocalArchiveName(value.archiveName)
    ) {
      return null;
    }
    return { kind: "local", archiveName: value.archiveName };
  }
  if (value.kind === "registry") {
    if (
      !exactKeys(value, [
        "kind",
        "registryUrl",
        "repositoryUrl",
        "artifactUrl",
      ]) ||
      !isSafeHttpsUrl(value.registryUrl) ||
      !isSafeHttpsUrl(value.repositoryUrl) ||
      !isSafeHttpsUrl(value.artifactUrl)
    ) {
      return null;
    }
    return {
      kind: "registry",
      registryUrl: value.registryUrl,
      repositoryUrl: value.repositoryUrl,
      artifactUrl: value.artifactUrl,
    };
  }
  if (value.kind === "github") {
    if (
      !exactKeys(value, [
        "kind",
        "repositoryUrl",
        "artifactUrl",
        "expectedArchiveSha256",
      ]) ||
      !isSafeHttpsUrl(value.repositoryUrl) ||
      !isSafeHttpsUrl(value.artifactUrl) ||
      typeof value.expectedArchiveSha256 !== "string" ||
      !SHA256_PATTERN.test(value.expectedArchiveSha256)
    ) {
      return null;
    }
    return {
      kind: "github",
      repositoryUrl: value.repositoryUrl,
      artifactUrl: value.artifactUrl,
      expectedArchiveSha256: value.expectedArchiveSha256,
    };
  }
  return null;
}

function parseInstalledArtifact(value: unknown, id: string): InstalledArtifact | null {
  if (!isRecord(value) || !exactKeys(value, [
    "version",
    "payloadSha256",
    "archiveSha256",
    "relativePath",
    "source",
    "installedAt",
  ])) return null;
  const identity = parseIdentity({ version: value.version, payloadSha256: value.payloadSha256 });
  const source = parseArtifactSource(value.source);
  if (identity === null || source === null || typeof value.archiveSha256 !== "string" ||
    !SHA256_PATTERN.test(value.archiveSha256) || typeof value.relativePath !== "string" ||
    !isSafeRelativeArtifactPath(value.relativePath, id) || !isIsoTimestamp(value.installedAt)) {
    return null;
  }
  return {
    ...identity,
    archiveSha256: value.archiveSha256,
    relativePath: value.relativePath,
    source,
    installedAt: value.installedAt,
  };
}

function identityKey(identity: ArtifactIdentity): string {
  return `${identity.version}\0${identity.payloadSha256}`;
}

function parsePluginRecord(value: unknown, id: string): PluginStateRecord | null {
  if (!isRecord(value) || !exactKeys(value, ["installed", "enabled", "pendingReview"]) ||
    !Array.isArray(value.installed) || !Array.isArray(value.pendingReview)) return null;
  const installed: InstalledArtifact[] = [];
  const installedKeys = new Set<string>();
  for (const candidate of value.installed) {
    const parsed = parseInstalledArtifact(candidate, id);
    if (parsed === null || installedKeys.has(identityKey(parsed))) return null;
    installedKeys.add(identityKey(parsed));
    installed.push(parsed);
  }
  const enabled = value.enabled === null ? null : parseIdentity(value.enabled);
  if (value.enabled !== null && enabled === null) return null;
  if (enabled !== null && !installedKeys.has(identityKey(enabled))) return null;
  const pendingReview: ArtifactIdentity[] = [];
  const pendingKeys = new Set<string>();
  for (const candidate of value.pendingReview) {
    const parsed = parseIdentity(candidate);
    if (parsed === null || pendingKeys.has(identityKey(parsed)) || !installedKeys.has(identityKey(parsed))) {
      return null;
    }
    pendingKeys.add(identityKey(parsed));
    pendingReview.push(parsed);
  }
  installed.sort(compareInstalledArtifacts);
  pendingReview.sort(compareIdentities);
  return { installed, enabled, pendingReview };
}

function compareIdentities(left: ArtifactIdentity, right: ArtifactIdentity): number {
  return left.version < right.version ? -1 : left.version > right.version ? 1 :
    left.payloadSha256 < right.payloadSha256 ? -1 : left.payloadSha256 > right.payloadSha256 ? 1 : 0;
}

function compareInstalledArtifacts(left: InstalledArtifact, right: InstalledArtifact): number {
  return compareIdentities(left, right);
}

export function parsePluginsState(value: unknown): PluginsState | null {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "plugins", "updatedAt"]) ||
    value.schemaVersion !== PLUGINS_STATE_SCHEMA_VERSION || !isRecord(value.plugins) ||
    !isIsoTimestamp(value.updatedAt)) return null;
  const plugins: Record<string, PluginStateRecord> = {};
  for (const id of Object.keys(value.plugins).sort()) {
    if (!PLUGIN_ID_PATTERN.test(id)) return null;
    const parsed = parsePluginRecord(value.plugins[id], id);
    if (parsed === null) return null;
    plugins[id] = parsed;
  }
  return {
    schemaVersion: PLUGINS_STATE_SCHEMA_VERSION,
    plugins,
    updatedAt: value.updatedAt,
  };
}

export function createEmptyPluginsState(updatedAt: string): PluginsState {
  if (!isIsoTimestamp(updatedAt)) throw new Error("updatedAt must be an RFC 3339 UTC timestamp.");
  return { schemaVersion: PLUGINS_STATE_SCHEMA_VERSION, plugins: {}, updatedAt };
}

export function safeLocalArtifactSource(archivePath: string): LocalArtifactSource {
  const archiveName = basename(archivePath);
  if (!isSafeLocalArchiveName(archiveName)) {
    throw new Error("Local archive basename is unsafe or exceeds the bounded provenance limit.");
  }
  return { kind: "local", archiveName };
}

function isSafeLocalArchiveName(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && basename(value) === value &&
    !/[\u0000-\u001f\u007f/\\]/u.test(value) && Buffer.byteLength(value, "utf8") <= MAX_ARCHIVE_NAME_BYTES;
}

function isSafeRelativeArtifactPath(value: string, id: string): boolean {
  return value.startsWith(`plugins/${id}/`) && !value.startsWith("/") &&
    !value.split("/").some((part) => part === "" || part === "." || part === ".." || /[\\\u0000-\u001f\u007f]/u.test(part));
}

export function sourceLabel(source: ArtifactSource): string {
  if (source.kind === "local") {
    return `Local archive: ${source.archiveName}`;
  }
  const repository = new URL(source.repositoryUrl);
  const parts = repository.pathname.split("/").filter((part) => part.length > 0);
  const ownerRepo = parts.slice(0, 2).join("/");
  return source.kind === "registry"
    ? `Registry: ${ownerRepo}`
    : `GitHub release: ${ownerRepo}`;
}

export async function loadPluginsState(options: {
  explodexHome: string;
}): Promise<PluginsStateLoadResult> {
  const path = pluginsStatePath(options.explodexHome);
  let text: string;
  try {
    const stateStat = await lstat(path);
    if (!stateStat.isFile() || stateStat.isSymbolicLink() ||
      (stateStat.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" && stateStat.uid !== process.getuid())) {
      return { status: "malformed" };
    }
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: "malformed" };
  }
  const state = parsePluginsState(parsed);
  return state === null ? { status: "malformed" } : { status: "valid", state };
}

export async function savePluginsStateAtomic(options: {
  explodexHome: string;
  state: PluginsState;
  adapters?: PluginsStateWriteAdapters;
}): Promise<void> {
  const parsed = parsePluginsState(options.state);
  if (parsed === null) throw new Error("Refusing to persist malformed plugin state.");
  await options.adapters?.beforeSerialize?.();
  const finalPath = pluginsStatePath(options.explodexHome);
  const parent = dirname(finalPath);
  const tempPath = join(parent, `.plugins-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const initialParentStat = await lstat(parent);
  if (!initialParentStat.isDirectory() || initialParentStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && initialParentStat.uid !== process.getuid())) {
    throw new Error("Plugin state directory must be a private directory owned by the current user.");
  }
  await chmod(parent, PRIVATE_DIRECTORY_MODE);
  const parentStat = await lstat(parent);
  if ((parentStat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("Plugin state directory must have mode 0700.");
  }
  let handle = null as Awaited<ReturnType<typeof open>> | null;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await options.adapters?.beforeTempWrite?.();
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await options.adapters?.beforeTempSync?.();
    await handle.sync();
    await handle.close();
    handle = null;
    await options.adapters?.beforeRename?.();
    await rename(tempPath, finalPath);
    await chmod(finalPath, PRIVATE_FILE_MODE);
    await options.adapters?.beforeDirectorySync?.();
    await syncDirectory(parent);
    const finalStat = await stat(finalPath);
    if (!finalStat.isFile() || (finalStat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error("Plugin state commit did not produce a private regular file.");
    }
  } catch (error: unknown) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle = null as Awaited<ReturnType<typeof open>> | null;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}
