import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SdkRuntimeIdentity } from "./types.ts";

/**
 * Resolve the transitional generated SDK runtime identity.
 * M2 will replace this with the packed @explodex/sdk artifact authority.
 * Until then, the monorepo `sdk/explodex-sdk.js` is the single generated runtime source.
 */
export function defaultGeneratedSdkRuntimePath(options?: {
  repositoryRoot?: string;
}): string {
  if (options?.repositoryRoot !== undefined && options.repositoryRoot !== "") {
    return join(options.repositoryRoot, "sdk", "explodex-sdk.js");
  }
  // packages/cli/src/host -> repo root is four levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "sdk", "explodex-sdk.js");
}

function extractVersion(source: string): string | null {
  const match =
    /const\s+VERSION\s*=\s*["']([^"']+)["']/.exec(source) ??
    /version:\s*["']([^"']+)["']/.exec(source);
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
