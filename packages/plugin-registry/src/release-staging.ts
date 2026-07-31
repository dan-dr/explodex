import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validateStandaloneArtifact } from "../../cli/src/plugin/artifact-validate.ts";
import {
  FIRST_PARTY_PLUGIN_IDS,
  generateRegistry,
  type ArtifactValidator,
  type PluginRegistryV1,
  type RegistryGenerationFailure,
} from "./registry-generation.ts";

export type ReleaseStagingFailure = RegistryGenerationFailure;

export type ReleaseStagingSuccess = {
  ok: true;
  outputPath: string;
  registrySha256: string;
  files: readonly string[];
};

export type ReleaseStagingResult = ReleaseStagingSuccess | ReleaseStagingFailure;
const CANONICAL_REPOSITORY_URL = "https://github.com/dan-dr/explodex";

function failure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ReleaseStagingFailure {
  return { ok: false, code, message, details };
}

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function parseRegistry(text: string): PluginRegistryV1 | ReleaseStagingFailure {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return failure("registry.staging-invalid", "registry.json is not valid JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return failure("registry.staging-invalid", "registry.json must be an object.");
  }
  const registry = raw as Record<string, unknown>;
  if (!exactKeys(registry, ["schemaVersion", "repositoryUrl", "plugins"]) ||
    registry.schemaVersion !== 1 || registry.repositoryUrl !== CANONICAL_REPOSITORY_URL ||
    registry.plugins === null || typeof registry.plugins !== "object" || Array.isArray(registry.plugins)) {
    return failure("registry.staging-invalid", "registry.json does not match schema version 1.");
  }
  const plugins = registry.plugins as Record<string, unknown>;
  const ids = Object.keys(plugins);
  if (ids.length !== FIRST_PARTY_PLUGIN_IDS.length ||
    ids.some((id, index) => id !== FIRST_PARTY_PLUGIN_IDS[index])) {
    return failure("registry.staging-invalid", "registry.json does not contain the exact seven first-party IDs.");
  }
  const entries: Record<string, PluginRegistryV1["plugins"][string]> = {};
  for (const id of ids) {
    const entry = plugins[id];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return failure("registry.staging-invalid", `Registry entry is invalid: ${id}`);
    }
    const value = entry as Record<string, unknown>;
    if (!exactKeys(value, [
      "version",
      "displayName",
      "description",
      "sdkRange",
      "artifactUrl",
      "payloadSha256",
      "archiveSha256",
    ]) || Object.values(value).some((part) => typeof part !== "string")) {
      return failure("registry.staging-invalid", `Registry entry fields are invalid: ${id}`);
    }
    entries[id] = value as PluginRegistryV1["plugins"][string];
  }
  return { schemaVersion: 1, repositoryUrl: registry.repositoryUrl, plugins: entries };
}

async function outputDirectoryIsEmpty(path: string): Promise<boolean | ReleaseStagingFailure> {
  try {
    const details = await stat(path);
    if (!details.isDirectory()) return failure("registry.staging-output", "Staging output path is not a directory.", { path });
    const entries = await readdir(path);
    if (entries.length > 0) return failure("registry.staging-output", "Refusing to overwrite a non-empty staging directory.", { path });
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    return failure("registry.staging-output", "Unable to inspect staging output directory.", { path });
  }
}

function artifactNameFromUrl(registry: PluginRegistryV1, releaseTag: string, artifactUrl: string): string | null {
  const prefix = `${registry.repositoryUrl}/releases/download/${encodeURIComponent(releaseTag)}/`;
  if (!artifactUrl.startsWith(prefix)) return null;
  const name = artifactUrl.slice(prefix.length);
  if (!name.endsWith(".tar.gz") || name.includes("/")) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

export async function verifyStagedRelease(options: {
  stagingDirectory: string;
  releaseTag: string;
  validateArtifact?: ArtifactValidator;
}): Promise<ReleaseStagingResult> {
  const stagingDirectory = resolve(options.stagingDirectory);
  const registryPath = join(stagingDirectory, "registry.json");
  let registryBytes: Buffer;
  try {
    registryBytes = await readFile(registryPath);
  } catch {
    return failure("registry.staging-invalid", "Staged registry.json is missing.", { path: registryPath });
  }
  const registry = parseRegistry(registryBytes.toString("utf8"));
  if ("ok" in registry) return registry;
  const validator = options.validateArtifact ?? validateStandaloneArtifact;
  const expectedFiles = new Set(["registry.json"]);
  for (const id of FIRST_PARTY_PLUGIN_IDS) {
    const entry = registry.plugins[id]!;
    const artifactName = artifactNameFromUrl(registry, options.releaseTag, entry.artifactUrl);
    if (artifactName === null) {
      return failure("registry.staging-invalid", `Artifact URL is not an immutable release asset for ${id}.`);
    }
    expectedFiles.add(artifactName);
    const artifactPath = join(stagingDirectory, artifactName);
    const validated = await validator(artifactPath);
    if (!validated.ok || validated.source !== "archive" || validated.archiveSha256 === null) {
      return failure("registry.staging-invalid", `Staged archive is invalid: ${id}.`, { path: artifactPath });
    }
    if (validated.id !== id || validated.version !== entry.version ||
      validated.displayName !== entry.displayName || validated.description !== entry.description ||
      validated.sdkRange !== entry.sdkRange || validated.payloadSha256 !== entry.payloadSha256 ||
      validated.archiveSha256 !== entry.archiveSha256) {
      return failure("registry.staging-invalid", `Staged archive metadata does not match registry entry: ${id}.`);
    }
  }
  const directoryEntries = await readdir(stagingDirectory, { withFileTypes: true });
  if (directoryEntries.some((entry) => !entry.isFile())) {
    return failure("registry.staging-invalid", "Staging directory cannot contain subdirectories or special files.");
  }
  const actualFiles = directoryEntries
    .map((entry) => entry.name)
    .sort(compareBytewise);
  const expectedSorted = [...expectedFiles].sort(compareBytewise);
  if (actualFiles.length !== expectedSorted.length || actualFiles.some((file, index) => file !== expectedSorted[index])) {
    return failure("registry.staging-invalid", "Staging directory must contain exactly registry.json and seven archives.", {
      expected: expectedSorted,
      actual: actualFiles,
    });
  }
  return {
    ok: true,
    outputPath: stagingDirectory,
    registrySha256: sha256(registryBytes),
    files: actualFiles,
  };
}

export async function stageRegistryRelease(options: {
  artifactPaths: readonly string[];
  outputDirectory: string;
  repository: string;
  releaseTag: string;
  validateArtifact?: ArtifactValidator;
}): Promise<ReleaseStagingResult> {
  const outputDirectory = resolve(options.outputDirectory);
  const empty = await outputDirectoryIsEmpty(outputDirectory);
  if (empty !== false && empty !== true) return empty;
  const generation = await generateRegistry({
    artifactPaths: options.artifactPaths,
    repository: options.repository,
    releaseTag: options.releaseTag,
    validateArtifact: options.validateArtifact,
  });
  if (!generation.ok) return generation;
  const temporaryDirectory = `${outputDirectory}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await mkdir(dirname(outputDirectory), { recursive: true });
    await mkdir(temporaryDirectory, { recursive: false });
    const copyPaths = [...options.artifactPaths].sort((left, right) => compareBytewise(basename(left), basename(right)));
    for (const sourcePath of copyPaths) {
      await copyFile(sourcePath, join(temporaryDirectory, basename(sourcePath)));
    }
    await writeFile(join(temporaryDirectory, "registry.json"), generation.text, "utf8");
    const verified = await verifyStagedRelease({
      stagingDirectory: temporaryDirectory,
      releaseTag: options.releaseTag,
      validateArtifact: options.validateArtifact,
    });
    if (!verified.ok) return verified;
    if (empty) await rmdir(outputDirectory);
    await rename(temporaryDirectory, outputDirectory);
    return { ...verified, outputPath: outputDirectory };
  } catch (error: unknown) {
    return failure("registry.staging-failed", error instanceof Error ? error.message : "Unable to stage registry release.");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
