import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { HostFileSystem } from "../host/adapters.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  DEFAULT_DEV_INSTANCE_ID,
  DEFAULT_DEV_ROOT_RELATIVE,
  DEV_DIRECTORY_MODE,
  DEV_LAYOUT_DIRECTORIES,
  DEV_STATE_FILE_NAME,
  PHASE0_CONTRACT_FILE_NAME,
} from "./constants.ts";
import type {
  DevLayoutEnsureResult,
  DevLayoutPaths,
  OwnershipFromLayoutResult,
} from "./types.ts";

function normalizePath(path: string): string {
  if (path === sep) return path;
  const normalized = normalize(path);
  return normalized.endsWith(sep) && normalized.length > 1
    ? normalized.slice(0, -1)
    : normalized;
}

function isPathInside(parent: string, child: string): boolean {
  const root = normalizePath(parent);
  const target = normalizePath(child);
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

/**
 * Resolve the default development root: ~/.explodex/dev/plugin-dev
 * Tests always pass an isolated osHome or explicit root.
 */
export function resolveDefaultDevRoot(options: {
  osHome?: string;
  explodexHome?: string;
  /** Advanced override is M4; M1-F04 only documents rejection of silent alternate roots. */
  explicitRoot?: string;
}): string {
  if (options.explicitRoot !== undefined && options.explicitRoot !== "") {
    if (!isAbsolute(options.explicitRoot)) {
      throw new Error("Development root override must be an absolute path");
    }
    return normalizePath(options.explicitRoot);
  }
  const explodexHome = resolveExplodexHome({
    osHome: options.osHome,
    explodexHome: options.explodexHome,
  });
  return normalizePath(join(explodexHome, DEFAULT_DEV_ROOT_RELATIVE));
}

export function describeDevLayout(rootPath: string): DevLayoutPaths {
  const root = normalizePath(rootPath);
  return {
    rootPath: root,
    electronUserDataPath: join(root, "electron-user-data"),
    codexHomePath: join(root, "codex-home"),
    explodexStatePath: join(root, "explodex-state"),
    logsPath: join(root, "logs"),
    locksPath: join(root, "locks"),
    statePath: join(root, DEV_STATE_FILE_NAME),
    phase0ContractPath: join(root, "explodex-state", PHASE0_CONTRACT_FILE_NAME),
  };
}

export type ProtectedPathSet = {
  mainProfilePath?: string;
  userCodexHome?: string;
  explodexHome?: string;
};

function isProtectedPath(path: string, protectedPaths: ProtectedPathSet): boolean {
  const candidates = [
    protectedPaths.mainProfilePath,
    protectedPaths.userCodexHome,
    protectedPaths.explodexHome,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    if (normalizePath(path) === normalizePath(candidate)) return true;
    if (isPathInside(candidate, path) || isPathInside(path, candidate)) return true;
  }
  return false;
}

/**
 * Privately create the canonical development layout with symlink-safe checks.
 * Path creation alone never grants process ownership (VAL-DEV-001 / VAL-HOST-007).
 */
export async function ensureDefaultDevLayout(options: {
  fs: HostFileSystem;
  rootPath: string;
  protectedPaths?: ProtectedPathSet;
}): Promise<DevLayoutEnsureResult> {
  const { fs } = options;
  const rootPath = normalizePath(options.rootPath);
  const layout = describeDevLayout(rootPath);
  const protectedPaths = options.protectedPaths ?? {};
  const created: string[] = [];
  const alreadyPresent: string[] = [];

  if (isProtectedPath(rootPath, protectedPaths)) {
    return {
      ok: false,
      error: {
        code: "protected_path",
        message: `Development root collides with a protected path: ${rootPath}`,
        path: rootPath,
      },
      grantsOwnership: false,
    };
  }

  const rootStat = await fs.stat(rootPath);
  if (rootStat.kind === "symlink") {
    return {
      ok: false,
      error: {
        code: "root_symlink",
        message: `Development root must not be a symlink: ${rootPath}`,
        path: rootPath,
      },
      grantsOwnership: false,
    };
  }
  if (rootStat.kind === "file" || rootStat.kind === "other") {
    return {
      ok: false,
      error: {
        code: "not_directory",
        message: `Development root exists and is not a directory: ${rootPath}`,
        path: rootPath,
      },
      grantsOwnership: false,
    };
  }

  if (!fs.mkdir) {
    return {
      ok: false,
      error: {
        code: "filesystem_error",
        message: "Filesystem adapter does not support mkdir",
      },
      grantsOwnership: false,
    };
  }

  let canonicalRoot = rootPath;
  try {
    if (rootStat.kind === "missing") {
      await fs.mkdir(rootPath, { recursive: true, mode: DEV_DIRECTORY_MODE });
      created.push(rootPath);
    } else {
      alreadyPresent.push(rootPath);
    }

    // Re-check after creation: reject if the root became a symlink.
    const postRoot = await fs.stat(rootPath);
    if (postRoot.kind === "symlink") {
      return {
        ok: false,
        error: {
          code: "root_symlink",
          message: `Development root resolved as a symlink after creation: ${rootPath}`,
          path: rootPath,
        },
        grantsOwnership: false,
      };
    }

    try {
      canonicalRoot = normalizePath(await fs.realpath(rootPath));
    } catch {
      canonicalRoot = rootPath;
    }
    if (canonicalRoot !== rootPath && !isPathInside(rootPath, canonicalRoot)) {
      // realpath escaped the requested root (symlink parent or mount swap).
      return {
        ok: false,
        error: {
          code: "path_escape",
          message: `Development root realpath escaped the requested path: ${canonicalRoot}`,
          path: canonicalRoot,
        },
        grantsOwnership: false,
      };
    }

    for (const directory of DEV_LAYOUT_DIRECTORIES) {
      const absolute = join(rootPath, directory);
      if (isProtectedPath(absolute, protectedPaths)) {
        return {
          ok: false,
          error: {
            code: "protected_path",
            message: `Development descendant collides with a protected path: ${absolute}`,
            path: absolute,
          },
          grantsOwnership: false,
        };
      }
      const existing = await fs.stat(absolute);
      if (existing.kind === "symlink") {
        return {
          ok: false,
          error: {
            code: "root_symlink",
            message: `Development descendant must not be a symlink: ${absolute}`,
            path: absolute,
          },
          grantsOwnership: false,
        };
      }
      if (existing.kind === "file" || existing.kind === "other") {
        return {
          ok: false,
          error: {
            code: "not_directory",
            message: `Development descendant exists and is not a directory: ${absolute}`,
            path: absolute,
          },
          grantsOwnership: false,
        };
      }
      if (existing.kind === "missing") {
        await fs.mkdir(absolute, { recursive: true, mode: DEV_DIRECTORY_MODE });
        created.push(absolute);
      } else {
        alreadyPresent.push(absolute);
      }

      let real = absolute;
      try {
        real = normalizePath(await fs.realpath(absolute));
      } catch {
        real = absolute;
      }
      if (!isPathInside(canonicalRoot, real)) {
        return {
          ok: false,
          error: {
            code: "path_escape",
            message: `Development descendant realpath escaped the instance root: ${real}`,
            path: real,
          },
          grantsOwnership: false,
        };
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        code: "filesystem_error",
        message: `Failed to create development layout: ${message}`,
        path: rootPath,
      },
      grantsOwnership: false,
    };
  }

  return {
    ok: true,
    layout: describeDevLayout(canonicalRoot),
    created,
    alreadyPresent,
    grantsOwnership: false,
  };
}

/**
 * Explicit ownership predicate: layout/path presence never owns a process.
 */
export function ownershipFromLayoutOnly(_layout: DevLayoutPaths): OwnershipFromLayoutResult {
  return {
    owned: false,
    reason: "paths_only_insufficient",
    message:
      "Development path creation alone does not grant process ownership. Lifecycle mutation requires a proven Phase 0 marker/isolation contract and exact process/endpoint identity.",
  };
}

export function defaultDevInstanceId(): typeof DEFAULT_DEV_INSTANCE_ID {
  return DEFAULT_DEV_INSTANCE_ID;
}

/** Resolve a parent directory path without following the final segment. */
export function parentDirectory(path: string): string {
  return dirname(resolve(path));
}
