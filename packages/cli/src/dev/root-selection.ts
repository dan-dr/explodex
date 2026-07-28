import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { HostFileSystem } from "../host/adapters.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { DEFAULT_DEV_ROOT_RELATIVE, DEFAULT_DEV_INSTANCE_ID } from "./constants.ts";
import { describeDevLayout } from "./layout.ts";
import type { DevInstanceState, DevLayoutPaths } from "./types.ts";

function normalized(path: string): string {
  const value = normalize(path);
  return value.length > 1 && value.endsWith(sep)
    ? value.slice(0, -1)
    : value;
}

function inside(parent: string, child: string): boolean {
  const root = normalized(parent);
  const candidate = normalized(child);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export type DevRootSelection = {
  /** Exact normalized path supplied by the caller before existing-ancestor realpath. */
  requestedRootPath?: string;
  rootPath: string;
  layout: DevLayoutPaths;
  explicit: boolean;
  defaultRootPath: string;
  explodexHome: string;
};

export type DevRootProtectedPaths = {
  mainProfilePaths?: readonly string[];
  userCodexHome?: string;
  explodexHome?: string;
};

export type DevRootValidationResult =
  | {
      ok: true;
      rootPath: string;
      layout: DevLayoutPaths;
      existingOwnedInstance: boolean;
    }
  | {
      ok: false;
      code:
        | "root_not_absolute"
        | "root_symlink"
        | "root_alias"
        | "path_escape"
        | "protected_path"
        | "nonempty_unowned_root"
        | "another_instance"
        | "root_not_directory"
        | "filesystem_error";
      message: string;
      requestedRoot: string;
      fallbackUsed: false;
    };

export function resolveDevRootSelection(options: {
  osHome?: string;
  explodexHome?: string;
  explicitRoot?: string | null;
}): DevRootSelection {
  const explodexHome = normalized(resolveExplodexHome({
    osHome: options.osHome,
    explodexHome: options.explodexHome,
  }));
  const defaultRootPath = normalized(
    `${explodexHome}${sep}${DEFAULT_DEV_ROOT_RELATIVE}`,
  );
  const raw = options.explicitRoot;
  if (raw === undefined || raw === null || raw === "") {
    return {
      requestedRootPath: defaultRootPath,
      rootPath: defaultRootPath,
      layout: describeDevLayout(defaultRootPath),
      explicit: false,
      defaultRootPath,
      explodexHome,
    };
  }
  if (!isAbsolute(raw)) {
    throw new Error("Development root override must be an absolute path.");
  }
  const rootPath = normalized(resolve(raw));
  return {
    requestedRootPath: rootPath,
    rootPath,
    layout: describeDevLayout(rootPath),
    explicit: true,
    defaultRootPath,
    explodexHome,
  };
}

/**
 * Canonicalize through the deepest existing ancestor before creation. A missing
 * child beneath the macOS `/tmp` alias is therefore recorded under `/private/tmp`.
 * The original normalized request remains attached to the selection so validation
 * can reject user-controlled symlink ancestors before their target is accepted.
 */
export async function canonicalizeDevRootSelection(options: {
  fs: HostFileSystem;
  selection: DevRootSelection;
}): Promise<DevRootSelection> {
  const requested = options.selection.rootPath;
  const requestedStat = await options.fs.stat(requested);
  if (requestedStat.kind === "symlink") {
    return options.selection;
  }
  const canonical = await canonicalizePathForCreation(options.fs, requested);
  const ancestor = canonical.ancestor;
  const canonicalAncestor = canonical.canonicalAncestor;
  const rootPath = canonical.path;
  const homeSuffix = relative(ancestor, options.selection.explodexHome);
  const canonicalExplodexHome =
    homeSuffix === "" || (!homeSuffix.startsWith("..") && !isAbsolute(homeSuffix))
      ? normalized(join(canonicalAncestor, homeSuffix))
      : options.selection.explodexHome;
  const defaultSuffix = relative(ancestor, options.selection.defaultRootPath);
  const canonicalDefaultRoot =
    defaultSuffix === "" ||
      (!defaultSuffix.startsWith("..") && !isAbsolute(defaultSuffix))
      ? normalized(join(canonicalAncestor, defaultSuffix))
      : options.selection.defaultRootPath;
  return {
    ...options.selection,
    rootPath,
    layout: describeDevLayout(rootPath),
    defaultRootPath: canonicalDefaultRoot,
    explodexHome: canonicalExplodexHome,
  };
}

export async function canonicalizePathForCreation(
  fs: HostFileSystem,
  requestedPath: string,
): Promise<{
  path: string;
  ancestor: string;
  canonicalAncestor: string;
}> {
  const requested = normalized(requestedPath);
  let ancestor = requested;
  for (;;) {
    const stat = await fs.stat(ancestor);
    if (stat.kind !== "missing") break;
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const stat = await fs.stat(ancestor);
  if (stat.kind === "missing") {
    return { path: requested, ancestor, canonicalAncestor: ancestor };
  }
  const canonicalAncestor = normalized(await fs.realpath(ancestor));
  const suffix = relative(ancestor, requested);
  const path = suffix.length === 0
    ? canonicalAncestor
    : normalized(join(canonicalAncestor, suffix));
  return { path, ancestor, canonicalAncestor };
}

function overlapsProtected(
  root: string,
  protectedPaths: DevRootProtectedPaths,
): boolean {
  const candidates = [
    ...(protectedPaths.mainProfilePaths ?? []),
    protectedPaths.userCodexHome,
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  return candidates.some((candidate) =>
    inside(candidate, root) || inside(root, candidate)
  );
}

async function firstSymlinkAncestor(
  fs: HostFileSystem,
  rootPath: string,
): Promise<string | null> {
  const parts = normalized(rootPath).split(sep).filter(Boolean);
  let current = rootPath.startsWith(sep) ? sep : "";
  for (const part of parts) {
    current = current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    const stat = await fs.stat(current);
    if (stat.kind === "symlink") return current;
    if (stat.kind === "missing") return null;
  }
  return null;
}

function isAllowedPlatformAlias(path: string): boolean {
  return path === "/tmp";
}

async function listDirectory(
  fs: HostFileSystem,
  path: string,
): Promise<string[] | null> {
  const optional = fs as HostFileSystem & {
    readDirectory?: (path: string) => Promise<string[]>;
  };
  if (optional.readDirectory === undefined) return null;
  return optional.readDirectory(path);
}

/**
 * Validate the one explicit development-root override without creating paths.
 * Rejection never falls back to the default root and never mutates the request.
 */
export async function validateDevRootSelection(options: {
  fs: HostFileSystem;
  selection: DevRootSelection;
  existingState: DevInstanceState | null;
  stateLoadStatus: "absent" | "valid" | "malformed";
  protectedPaths: DevRootProtectedPaths;
}): Promise<DevRootValidationResult> {
  const { fs, selection } = options;
  const requestedRoot = selection.rootPath;
  if (!isAbsolute(requestedRoot)) {
    return {
      ok: false,
      code: "root_not_absolute",
      message: "Development root must be absolute.",
      requestedRoot,
      fallbackUsed: false,
    };
  }

  const protectedExplodexHome = normalized(
    options.protectedPaths.explodexHome ?? selection.explodexHome,
  );
  if (
    overlapsProtected(requestedRoot, options.protectedPaths) ||
    (selection.explicit && inside(protectedExplodexHome, requestedRoot)) ||
    inside(requestedRoot, protectedExplodexHome)
  ) {
    return {
      ok: false,
      code: "protected_path",
      message: `Development root overlaps protected user state: ${requestedRoot}`,
      requestedRoot,
      fallbackUsed: false,
    };
  }

  try {
    const symlink = await firstSymlinkAncestor(
      fs,
      selection.requestedRootPath ?? requestedRoot,
    );
    if (symlink !== null) {
      if (isAllowedPlatformAlias(symlink)) {
        // `/tmp` is the documented macOS platform alias to `/private/tmp`.
      } else {
      return {
        ok: false,
        code: "root_symlink",
        message: `Development root or ancestor is a symlink: ${symlink}`,
        requestedRoot: selection.requestedRootPath ?? requestedRoot,
        fallbackUsed: false,
      };
      }
    }

    const stat = await fs.stat(requestedRoot);
    if (stat.kind === "file" || stat.kind === "other") {
      return {
        ok: false,
        code: "root_not_directory",
        message: `Development root is not a directory: ${requestedRoot}`,
        requestedRoot,
        fallbackUsed: false,
      };
    }
    if (stat.kind === "directory") {
      const canonical = normalized(await fs.realpath(requestedRoot));
      if (canonical !== requestedRoot) {
        return {
          ok: false,
          code: "root_alias",
          message: `Development root aliases another canonical path: ${canonical}`,
          requestedRoot,
          fallbackUsed: false,
        };
      }
    }

    const state = options.existingState;
    if (state !== null) {
      if (
        state.schemaVersion !== 1 ||
        state.role !== "development" ||
        state.instanceId !== DEFAULT_DEV_INSTANCE_ID ||
        normalized(state.rootPath) !== requestedRoot
      ) {
        return {
          ok: false,
          code: "another_instance",
          message: "Development root belongs to another or mismatched instance.",
          requestedRoot,
          fallbackUsed: false,
        };
      }
      return {
        ok: true,
        rootPath: requestedRoot,
        layout: selection.layout,
        existingOwnedInstance: true,
      };
    }

    if (stat.kind === "directory") {
      const entries = await listDirectory(fs, requestedRoot);
      if (entries === null) {
        return {
          ok: false,
          code: "filesystem_error",
          message:
            "Cannot prove an existing development override root is empty without directory inventory.",
          requestedRoot,
          fallbackUsed: false,
        };
      }
      if (entries.length > 0 || options.stateLoadStatus === "malformed") {
        return {
          ok: false,
          code: "nonempty_unowned_root",
          message:
            "Existing nonempty development root has no valid exact ownership state.",
          requestedRoot,
          fallbackUsed: false,
        };
      }
    }

    return {
      ok: true,
      rootPath: requestedRoot,
      layout: selection.layout,
      existingOwnedInstance: false,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      code: "filesystem_error",
      message: error instanceof Error
        ? error.message
        : "Development root validation failed.",
      requestedRoot,
      fallbackUsed: false,
    };
  }
}
