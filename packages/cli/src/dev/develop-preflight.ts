import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CdpAdapter } from "../cdp/adapters.ts";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import {
  createDefaultHostAdapters,
  type HostAdapters,
} from "../host/adapters.ts";
import {
  createDefaultHostStatusAdapters,
} from "../host/process-adapters.ts";
import type { HostStatusAdapters } from "../host/status.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { captureEphemeralPluginArtifact } from "./ephemeral-artifact.ts";
import { routeDevArtifactLifecycle } from "./injection-routing.ts";
import {
  prepareOwnedDevTarget,
  type PreparedOwnedDevTarget,
} from "./injection-operation.ts";
import type {
  DevelopPreflightResult,
  DevelopPreflightSuccess,
} from "./develop-operation.ts";
import { verifyDistGeneration } from "../plugin/generation.ts";
import { validatePluginSource } from "../plugin/validate.ts";
import {
  validateLocalSdkSourceWorkspace,
  type ValidatedLocalSdkSource,
} from "./local-sdk.ts";

export type ProductionDevelopPreflightSuccess = DevelopPreflightSuccess & {
  prepared: PreparedOwnedDevTarget;
  localSdkSource?: ValidatedLocalSdkSource;
};

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

async function canonicalDirectory(path: string): Promise<
  | { ok: true; path: string }
  | { ok: false; code: string; message: string }
> {
  const requested = resolve(path);
  try {
    const stats = await lstat(requested);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return {
        ok: false,
        code: "develop.workspace-unsafe",
        message: "Development workspace must be one real directory, not a link.",
      };
    }
    const canonical = await realpath(requested);
    return { ok: true, path: canonical };
  } catch (error: unknown) {
    return {
      ok: false,
      code: "develop.workspace-invalid",
      message: error instanceof Error
        ? error.message
        : "Development workspace is unavailable.",
    };
  }
}

async function requiredWorkspacePathsStayContained(
  workspacePath: string,
): Promise<string | null> {
  for (const relativePath of [
    "package.json",
    "explodex.config.ts",
    "src",
    "README.md",
    "tsconfig.json",
  ]) {
    try {
      const canonical = await realpath(join(workspacePath, relativePath));
      if (!isWithin(workspacePath, canonical)) return relativePath;
    } catch {
      return relativePath;
    }
  }
  return null;
}

async function findNestedPluginWorkspace(
  workspacePath: string,
): Promise<string | null> {
  const queue = [workspacePath];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    if (
      directory !== workspacePath &&
      names.has("package.json") &&
      names.has("explodex.config.ts") &&
      entries.some((entry) => entry.name === "src" && entry.isDirectory())
    ) {
      return directory;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name === "dist" ||
        entry.name === "dist-build" ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".explodex-dist-")
      ) continue;
      queue.push(join(directory, entry.name));
    }
  }
  return null;
}

/**
 * Complete foreground preflight. Workspace, overlap, and current-dist checks
 * run before any ownership/CDP inspection.
 */
export async function runDevelopPreflight(options: {
  workspacePath: string;
  sdkSourcePath?: string | null;
  osHome: string;
  explodexHome?: string;
  explicitRoot?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  hostAdapters?: HostAdapters;
  statusAdapters?: HostStatusAdapters;
  cdp?: CdpAdapter;
}): Promise<
  | { ok: true; value: ProductionDevelopPreflightSuccess }
  | Extract<DevelopPreflightResult, { ok: false }>
> {
  const workspace = await canonicalDirectory(options.workspacePath);
  if (!workspace.ok) return workspace;
  const explodexHome = resolve(resolveExplodexHome({
    osHome: options.osHome,
    explodexHome: options.explodexHome,
  }));
  const requestedDevRoot = options.explicitRoot === null ||
      options.explicitRoot === undefined
    ? join(explodexHome, "dev", "plugin-dev")
    : resolve(options.explicitRoot);
  for (const protectedInput of [
    explodexHome,
    requestedDevRoot,
    "/Applications/ChatGPT.app",
    join(options.osHome, ".codex"),
    join(options.osHome, "Library", "Application Support", "ChatGPT"),
    join(options.osHome, "Library", "Application Support", "Codex"),
  ]) {
    const protectedPath = await realpath(protectedInput).catch(() =>
      resolve(protectedInput)
    );
    if (pathsOverlap(workspace.path, protectedPath)) {
      return {
        ok: false,
        code: "develop.workspace-unsafe",
        message:
          "Plugin workspace overlaps protected application, state, profile, or development-instance paths.",
      };
    }
  }
  const escaped = await requiredWorkspacePathsStayContained(workspace.path);
  if (escaped !== null) {
    return {
      ok: false,
      code: "develop.workspace-unsafe",
      message: `Plugin workspace path is missing or escapes the workspace: ${escaped}.`,
    };
  }
  const nestedWorkspace = await findNestedPluginWorkspace(workspace.path)
    .catch(() => null);
  if (nestedWorkspace !== null) {
    return {
      ok: false,
      code: "develop.workspace-unsafe",
      message:
        "Development root must contain exactly one plugin workspace; a nested plugin workspace was found.",
      details: {
        nestedRelativePath: relative(workspace.path, nestedWorkspace),
      },
    };
  }
  try {
    const distStats = await lstat(join(workspace.path, "dist"));
    if (distStats.isSymbolicLink()) {
      return {
        ok: false,
        code: "develop.workspace-unsafe",
        message: "Plugin dist output must not be a symlink.",
      };
    }
  } catch {
    // Missing dist is classified below by generation verification.
  }

  let localSdkSource: ValidatedLocalSdkSource | null = null;
  let localPluginLifecycle:
    | "dynamic"
    | "renderer-start"
    | "app-start"
    | null = null;
  if (options.sdkSourcePath !== null && options.sdkSourcePath !== undefined) {
    const sdkSource = await validateLocalSdkSourceWorkspace({
      sdkSourcePath: options.sdkSourcePath,
      pluginWorkspacePath: workspace.path,
      explodexHome,
      devRootPath: requestedDevRoot,
    });
    if (!sdkSource.ok) return sdkSource;
    localSdkSource = sdkSource.value;
    const pluginSource = await validatePluginSource({
      workspacePath: workspace.path,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (!pluginSource.ok) {
      return {
        ok: false,
        code: pluginSource.code,
        message: pluginSource.message,
        details: pluginSource.details,
      };
    }
    localPluginLifecycle = pluginSource.report.lifecycle;
  }

  let artifact:
    | Awaited<ReturnType<typeof captureEphemeralPluginArtifact>>
    | null = null;
  if (localSdkSource === null) {
    const generation = await verifyDistGeneration({
      workspacePath: workspace.path,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (!generation.ok) {
      return {
        ok: false,
        code: "develop.dist-stale",
        message: generation.message,
        details: generation.details,
      };
    }
    artifact = await captureEphemeralPluginArtifact({
      artifactPath: join(workspace.path, "dist"),
      signal: options.signal,
    });
    if (!artifact.ok) {
      return {
        ok: false,
        code: artifact.code,
        message: artifact.message,
        details: artifact.details,
      };
    }
    if (artifact.validation.payloadSha256 !== generation.payloadSha256) {
      return {
        ok: false,
        code: "develop.dist-stale",
        message: "Current dist identity changed during foreground preflight.",
      };
    }
  }

  let sdkRuntimeIdentity: DevelopPreflightSuccess["sdkRuntimeIdentity"];
  try {
    const sdkRuntime = localSdkSource?.runtime ??
      await resolveSdkRuntimeIdentityForCli();
    sdkRuntimeIdentity = {
      version: sdkRuntime.version,
      sha256: sdkRuntime.sha256,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      code: "compatibility.unproven",
      message: error instanceof Error
        ? error.message
        : "Current generated SDK runtime identity is unavailable.",
    };
  }

  const prepared = await prepareOwnedDevTarget({
    operation: "develop",
    osHome: options.osHome,
    explodexHome,
    explicitRoot: options.explicitRoot,
    signal: options.signal,
    hostAdapters: options.hostAdapters ?? await createDefaultHostAdapters(),
    statusAdapters:
      options.statusAdapters ?? await createDefaultHostStatusAdapters(),
    cdp: options.cdp ?? createNodeCdpAdapter(),
    ...(localSdkSource === null
      ? {}
      : { sdkRuntime: localSdkSource.runtime }),
    requireCompatibility: localSdkSource === null,
  });
  if (!prepared.ok) return prepared;
  const normalizedLifecycle = artifact?.ok === true
    ? artifact.validation.lifecycle
    : localPluginLifecycle;
  if (normalizedLifecycle === null) {
    return {
      ok: false,
      code: "develop.preflight-failed",
      message: "Plugin lifecycle was not established during preflight.",
    };
  }
  return {
    ok: true,
    value: {
      workspacePath: workspace.path,
      watchedPaths: [
        workspace.path,
        ...(localSdkSource === null ? [] : [localSdkSource.rootPath]),
      ],
      excludedPaths: [
        join(workspace.path, "dist"),
        join(workspace.path, "node_modules"),
        ...(localSdkSource === null
          ? []
          : [
              join(localSdkSource.rootPath, "dist"),
              join(localSdkSource.rootPath, "dist-build"),
              join(localSdkSource.rootPath, "node_modules"),
            ]),
      ],
      lifecycle: normalizedLifecycle,
      route: routeDevArtifactLifecycle(normalizedLifecycle),
      target: prepared.value.target,
      pluginIdentity: artifact?.ok === true
        ? {
            id: artifact.validation.id,
            version: artifact.validation.version,
            payloadSha256: artifact.validation.payloadSha256,
          }
        : null,
      sdkRuntimeIdentity,
      distPath: join(workspace.path, "dist"),
      prepared: prepared.value,
      ...(localSdkSource === null
        ? {}
        : {
            usesLocalSdk: true,
            localSdkSource,
          }),
    },
  };
}
