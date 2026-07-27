/**
 * Declared asset path validation and byte-exact staging under dist/assets/**.
 * Config asset paths are relative to the workspace assets/ root.
 */

import { copyFile, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compareBytewise } from "./dist-files.ts";
import {
  PayloadPathTopologyTracker,
  validateNormalizedPayloadPath,
} from "./payload-path.ts";

export type NormalizedAsset = {
  /** Declared path relative to assets/ root (posix). */
  readonly declared: string;
  /** Installable path under dist/ (posix, starts with assets/). */
  readonly installable: string;
  /** Absolute source path. */
  readonly sourcePath: string;
};

export type AssetStageSuccess = {
  ok: true;
  assets: readonly NormalizedAsset[];
  /** Sorted installable asset paths for plugin.json. */
  installablePaths: readonly string[];
};

export type AssetStageFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type AssetStageResult = AssetStageSuccess | AssetStageFailure;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Normalize and validate declared asset paths, ensuring each source exists
 * as a regular file under workspace/assets without escaping links.
 */
export async function normalizeDeclaredAssets(options: {
  workspacePath: string;
  declared: readonly string[];
}): Promise<AssetStageResult> {
  const workspacePath = resolve(options.workspacePath);
  const assetsRoot = join(workspacePath, "assets");
  const seenDeclared = new Set<string>();
  const topology = new PayloadPathTopologyTracker();
  const normalized: NormalizedAsset[] = [];

  for (const raw of options.declared) {
    if (typeof raw !== "string") {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Asset paths must be non-empty strings.",
      };
    }
    const declared = raw.trim() === raw ? raw : raw; // preserve exact; reject trim mismatch below
    if (declared !== raw || declared.trim() !== declared) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: `Asset path must not have leading or trailing whitespace: ${JSON.stringify(raw)}`,
        details: { asset: raw },
      };
    }
    const installable = `assets/${declared}`;
    const validated = validateNormalizedPayloadPath(installable, { kind: "file" });
    if (!validated.ok) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: validated.message,
        details: { asset: declared, entryClass: validated.entryClass },
      };
    }
    if (seenDeclared.has(declared)) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: `Duplicate asset declaration: ${declared}`,
        details: { asset: declared },
      };
    }
    seenDeclared.add(declared);

    const topologyFailure = topology.addFileWithImplicitDirectories(validated.validated);
    if (topologyFailure !== null) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: topologyFailure.message,
        details: {
          asset: declared,
          installable,
          entryClass: topologyFailure.entryClass,
        },
      };
    }

    const sourcePath = join(assetsRoot, ...declared.split("/"));
    let sourceStats;
    try {
      sourceStats = await lstat(sourcePath);
    } catch {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: `Declared asset is missing: ${declared}`,
        details: { asset: declared },
      };
    }

    if (sourceStats.isSymbolicLink()) {
      let real;
      try {
        real = await realpath(sourcePath);
      } catch {
        return {
          ok: false,
          code: "plugin.source.invalid",
          message: `Declared asset symlink is unreadable: ${declared}`,
          details: { asset: declared },
        };
      }
      const assetsReal = await realpath(assetsRoot).catch(() => assetsRoot);
      const rel = relative(assetsReal, real);
      if (rel.startsWith("..") || rel === "" || (rel.length > 0 && rel.startsWith(`..${sep}`))) {
        return {
          ok: false,
          code: "plugin.source.invalid",
          message: `Declared asset symlink escapes assets/: ${declared}`,
          details: { asset: declared },
        };
      }
      const targetStats = await stat(real);
      if (!targetStats.isFile()) {
        return {
          ok: false,
          code: "plugin.source.invalid",
          message: `Declared asset symlink target is not a regular file: ${declared}`,
          details: { asset: declared },
        };
      }
    } else if (!sourceStats.isFile()) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: `Declared asset is not a regular file: ${declared}`,
        details: { asset: declared },
      };
    }

    // Ensure resolved path stays under assets root even for non-link paths.
    const resolvedSource = resolve(sourcePath);
    const resolvedRoot = resolve(assetsRoot) + sep;
    if (!resolvedSource.startsWith(resolvedRoot) && resolvedSource !== resolve(assetsRoot)) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: `Declared asset path escapes assets/: ${declared}`,
        details: { asset: declared },
      };
    }

    normalized.push({
      declared,
      installable: validated.validated.path,
      sourcePath,
    });
  }

  normalized.sort((left, right) => compareBytewise(left.installable, right.installable));
  return {
    ok: true,
    assets: normalized,
    installablePaths: normalized.map((asset) => asset.installable),
  };
}

/**
 * Copy normalized assets into stagingDir/assets/** byte-for-byte.
 * Does not create parent assets directories for undeclared paths.
 */
export async function stageDeclaredAssets(options: {
  stagingDir: string;
  assets: readonly NormalizedAsset[];
}): Promise<{ ok: true } | AssetStageFailure> {
  for (const asset of options.assets) {
    const destination = join(options.stagingDir, ...asset.installable.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    // copyFile follows a final symlink to the target file contents for regular files.
    // Escaping links were rejected during normalize.
    await copyFile(asset.sourcePath, destination);
  }
  return { ok: true };
}

export function normalizeAssetPathForDisplay(path: string): string {
  return toPosix(path);
}
