import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { validateStandaloneArtifact } from "../../cli/src/plugin/artifact-validate.ts";
import { encodeArtifactIdentity } from "../../cli/src/plugin/identity-encode.ts";

export const REGISTRY_SCHEMA_VERSION = 1 as const;

export const FIRST_PARTY_PLUGIN_IDS = [
  "command-menu-threads",
  "effort-shortcuts",
  "feature-flags-playground",
  "project-colors",
  "project-pins",
  "toggle-autoscroll",
  "usage-reset-glance",
] as const;

export type FirstPartyPluginId = (typeof FIRST_PARTY_PLUGIN_IDS)[number];

export type RegistryPluginEntry = {
  version: string;
  displayName: string;
  description: string;
  sdkRange: string;
  artifactUrl: string;
  payloadSha256: string;
  archiveSha256: string;
};

export type PluginRegistryV1 = {
  schemaVersion: 1;
  repositoryUrl: string;
  plugins: Record<string, RegistryPluginEntry>;
};

export type RegistryGenerationFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type RegistryGenerationSuccess = {
  ok: true;
  registry: PluginRegistryV1;
  text: string;
};

export type RegistryGenerationResult =
  | RegistryGenerationSuccess
  | RegistryGenerationFailure;

export type ValidatedArchive = {
  ok: true;
  id: string;
  version: string;
  displayName: string;
  description: string;
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  sdkRange: string;
  payloadSha256: string;
  archiveSha256: string | null;
  source: "directory" | "archive";
};

export type ArtifactValidator = (path: string) => Promise<
  ValidatedArchive | { ok: false; code: string; message: string; details?: Record<string, unknown> }
>;

const ENTRY_KEYS = [
  "version",
  "displayName",
  "description",
  "sdkRange",
  "artifactUrl",
  "payloadSha256",
  "archiveSha256",
] as const;

function fail(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RegistryGenerationFailure {
  return { ok: false, code, message, details };
}

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isExpectedPluginSet(ids: readonly string[], expectedIds: readonly string[]): boolean {
  if (ids.length !== expectedIds.length) return false;
  return ids.every((id, index) => id === expectedIds[index]);
}

function githubRepositoryUrl(repository: string): string {
  const normalized = repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) {
    throw new Error("repository must be an owner/repository GitHub identifier");
  }
  return `https://github.com/${normalized}`;
}

function immutableGitHubAssetUrl(options: {
  repository: string;
  releaseTag: string;
  archiveFileName: string;
}): string {
  const repositoryUrl = githubRepositoryUrl(options.repository);
  if (options.releaseTag.length === 0 || options.releaseTag.includes("/")) {
    throw new Error("releaseTag must be a non-empty GitHub Release tag without a slash");
  }
  if (basename(options.archiveFileName) !== options.archiveFileName ||
    !options.archiveFileName.endsWith(".tar.gz")) {
    throw new Error("archive filename is not canonical");
  }
  return `${repositoryUrl}/releases/download/${encodeURIComponent(options.releaseTag)}/${encodeURIComponent(options.archiveFileName)}`;
}

function serializeRegistry(registry: PluginRegistryV1): string {
  const plugins: Record<string, Record<(typeof ENTRY_KEYS)[number], string>> = {};
  for (const id of Object.keys(registry.plugins).sort(compareBytewise)) {
    const entry = registry.plugins[id]!;
    const ordered: Record<(typeof ENTRY_KEYS)[number], string> = {
      version: entry.version,
      displayName: entry.displayName,
      description: entry.description,
      sdkRange: entry.sdkRange,
      artifactUrl: entry.artifactUrl,
      payloadSha256: entry.payloadSha256,
      archiveSha256: entry.archiveSha256,
    };
    plugins[id] = ordered;
  }
  return `${JSON.stringify({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    repositoryUrl: registry.repositoryUrl,
    plugins,
  }, null, 2)}\n`;
}

async function validateArchive(path: string): Promise<
  ValidatedArchive | { ok: false; code: string; message: string; details?: Record<string, unknown> }
> {
  return validateStandaloneArtifact(path);
}

export async function generateRegistry(options: {
  artifactPaths: readonly string[];
  repository: string;
  releaseTag: string;
  expectedPluginIds?: readonly string[];
  validateArtifact?: ArtifactValidator;
}): Promise<RegistryGenerationResult> {
  const expectedIds = [...(options.expectedPluginIds ?? FIRST_PARTY_PLUGIN_IDS)].sort(compareBytewise);
  if (new Set(expectedIds).size !== expectedIds.length) {
    return fail("registry.invalid-input", "Expected plugin IDs must be unique.");
  }
  if (options.artifactPaths.length !== expectedIds.length) {
    return fail(
      "registry.incomplete",
      `Registry requires exactly ${expectedIds.length} canonical plugin archives.`,
      { expected: expectedIds.length, actual: options.artifactPaths.length },
    );
  }

  const validator = options.validateArtifact ?? validateArchive;
  const entries: Array<{ id: string; entry: RegistryPluginEntry }> = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const inputPath of options.artifactPaths) {
    const artifactPath = resolve(inputPath);
    if (seenPaths.has(artifactPath)) {
      return fail("registry.duplicate-artifact", "Artifact input paths must be unique.", {
        path: artifactPath,
      });
    }
    seenPaths.add(artifactPath);
    if (!artifactPath.endsWith(".tar.gz")) {
      return fail("registry.noncanonical-artifact", "Registry accepts canonical .tar.gz archives only.", {
        path: artifactPath,
      });
    }
    const validated = await validator(artifactPath);
    if (!validated.ok) {
      return fail("registry.invalid-artifact", validated.message, {
        path: artifactPath,
        artifactCode: validated.code,
        ...validated.details,
      });
    }
    if (validated.source !== "archive" || validated.archiveSha256 === null) {
      return fail("registry.noncanonical-artifact", "Registry accepts validated archive artifacts only.", {
        path: artifactPath,
      });
    }
    if (seenIds.has(validated.id)) {
      return fail("registry.duplicate-plugin-id", "Registry cannot contain duplicate plugin IDs.", {
        id: validated.id,
      });
    }
    seenIds.add(validated.id);
    let canonicalArchiveFileName: string;
    try {
      canonicalArchiveFileName = encodeArtifactIdentity({
        id: validated.id,
        version: validated.version,
        payloadSha256: validated.payloadSha256,
      }).archiveFileName;
    } catch (error: unknown) {
      return fail(
        "registry.invalid-artifact",
        error instanceof Error ? error.message : "Artifact identity cannot be encoded.",
        { id: validated.id },
      );
    }
    if (basename(artifactPath) !== canonicalArchiveFileName) {
      return fail(
        "registry.noncanonical-artifact",
        "Artifact filename does not match its validated plugin identity.",
        { id: validated.id, expected: canonicalArchiveFileName },
      );
    }
    let artifactUrl: string;
    try {
      artifactUrl = immutableGitHubAssetUrl({
        repository: options.repository,
        releaseTag: options.releaseTag,
        archiveFileName: canonicalArchiveFileName,
      });
    } catch (error: unknown) {
      return fail(
        "registry.invalid-release-target",
        error instanceof Error ? error.message : "Invalid GitHub release target.",
      );
    }
    entries.push({
      id: validated.id,
      entry: {
        version: validated.version,
        displayName: validated.displayName,
        description: validated.description,
        sdkRange: validated.sdkRange,
        artifactUrl,
        payloadSha256: validated.payloadSha256,
        archiveSha256: validated.archiveSha256,
      },
    });
  }
  entries.sort((left, right) => compareBytewise(left.id, right.id));
  if (!isExpectedPluginSet(entries.map((entry) => entry.id), expectedIds)) {
    return fail("registry.incomplete", "Registry entries do not match the required first-party plugin IDs.", {
      expected: expectedIds,
      actual: entries.map((entry) => entry.id),
    });
  }
  let repositoryUrl: string;
  try {
    repositoryUrl = githubRepositoryUrl(options.repository);
  } catch (error: unknown) {
    return fail(
      "registry.invalid-release-target",
      error instanceof Error ? error.message : "Invalid GitHub release target.",
    );
  }
  const registry: PluginRegistryV1 = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    repositoryUrl,
    plugins: Object.fromEntries(entries.map(({ id, entry }) => [id, entry])),
  };
  return { ok: true, registry, text: serializeRegistry(registry) };
}

export async function writeGeneratedRegistry(options: {
  outputPath: string;
  generation: RegistryGenerationSuccess;
}): Promise<void> {
  const outputPath = resolve(options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, options.generation.text, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
