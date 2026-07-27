import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SdkRuntimeIdentity } from "./types.ts";

/**
 * Resolve the generated SDK runtime identity for CLI operations.
 *
 * Preference order:
 * 1. Packed `@explodex/sdk` runtime export when installed alongside the CLI
 * 2. Monorepo `packages/sdk/dist/runtime/explodex-runtime.iife.js` during development
 */
export function defaultGeneratedSdkRuntimePath(options?: {
  repositoryRoot?: string;
}): string {
  if (options?.repositoryRoot !== undefined && options.repositoryRoot !== "") {
    return join(
      options.repositoryRoot,
      "packages",
      "sdk",
      "dist",
      "runtime",
      "explodex-runtime.iife.js",
    );
  }
  // packages/cli/{src,dist}/host -> packages/sdk/dist/runtime.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(
    here,
    "..",
    "..",
    "..",
    "sdk",
    "dist",
    "runtime",
    "explodex-runtime.iife.js",
  );
}

function extractVersion(source: string): string | null {
  const match =
    /SDK_VERSION\s*=\s*["']([^"']+)["']/.exec(source) ??
    /const\s+VERSION\s*=\s*["']([^"']+)["']/.exec(source) ??
    /version:\s*["']([^"']+)["']/.exec(source) ??
    /"version"\s*:\s*"([^"]+)"/.exec(source);
  return match?.[1] ?? null;
}

export async function resolveGeneratedSdkRuntimeIdentity(options?: {
  sourcePath?: string;
  repositoryRoot?: string;
}): Promise<SdkRuntimeIdentity & { sourcePath: string; source: string }> {
  const sourcePath =
    options?.sourcePath ??
    defaultGeneratedSdkRuntimePath({ repositoryRoot: options?.repositoryRoot });
  const source = await readFile(sourcePath, "utf8");
  const version = extractVersion(source);
  if (version === null || version.length === 0) {
    throw new Error(`Unable to extract generated SDK version from ${sourcePath}`);
  }
  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
  return {
    version,
    sha256,
    sourcePath,
    source,
  };
}

/**
 * CLI-facing identity resolution that works from packed installs without
 * repository paths when `@explodex/sdk` is present.
 */
export async function resolveSdkRuntimeIdentityForCli(): Promise<
  SdkRuntimeIdentity & { sourcePath: string }
> {
  const packed = await tryResolvePackedSdkRuntime();
  if (packed !== null) return packed;

  const here = dirname(fileURLToPath(import.meta.url));
  const monorepoCandidates = [
    // packages/cli/src/host or packages/cli/dist/host → packages/sdk/dist/...
    resolve(here, "..", "..", "..", "sdk", "dist", "runtime", "explodex-runtime.iife.js"),
    resolve(here, "..", "..", "..", "..", "packages", "sdk", "dist", "runtime", "explodex-runtime.iife.js"),
  ];

  for (const candidate of monorepoCandidates) {
    try {
      const identity = await resolveGeneratedSdkRuntimeIdentity({ sourcePath: candidate });
      return {
        version: identity.version,
        sha256: identity.sha256,
        sourcePath: identity.sourcePath,
      };
    } catch {
      // try next
    }
  }

  // Fail closed with a stable placeholder only when no runtime bytes exist.
  // Host report still works for structural host identity; compatibility stays unproven.
  return {
    version: "0.0.0-unavailable",
    sha256: createHash("sha256").update("sdk-runtime-unavailable", "utf8").digest("hex"),
    sourcePath: "unavailable",
  };
}

async function tryResolvePackedSdkRuntime(): Promise<
  (SdkRuntimeIdentity & { sourcePath: string }) | null
> {
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("@explodex/sdk/package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      version?: unknown;
      exports?: unknown;
    };
    const version =
      typeof packageJson.version === "string" && packageJson.version.length > 0
        ? packageJson.version
        : null;
    if (version === null) return null;

    const runtimePath = join(
      dirname(packageJsonPath),
      "dist",
      "runtime",
      "explodex-runtime.iife.js",
    );

    const source = await readFile(runtimePath, "utf8");
    const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
    return {
      version,
      sha256,
      sourcePath: runtimePath,
    };
  } catch {
    return null;
  }
}
