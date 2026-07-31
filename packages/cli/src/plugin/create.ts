import { access, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { deriveIdFromPackageName, displayNameFromId } from "./identity.ts";
import {
  entryTemplate,
  explodexConfigTemplate,
  packageJsonTemplate,
  readmeTemplate,
  tsconfigTemplate,
} from "./templates.ts";
import {
  OPTIONAL_EMPTY_DIRECTORIES,
  REQUIRED_WORKSPACE_FILES,
  type CreateWorkspaceResult,
} from "./types.ts";

const LEGACY_FORBIDDEN_NAMES = new Set([
  "plugin.json",
  "index.js",
  "index.js.map",
  "checksums.json",
  "manifest.json",
]);

/**
 * Create one safe generated-only plugin workspace.
 * Fails without partial creation on unsafe names, path escape, nonempty destinations,
 * or existing canonical files.
 */
export async function createPluginWorkspace(options: {
  directory: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<CreateWorkspaceResult> {
  const cwd = options.cwd ?? process.cwd();
  const requested = options.directory.trim();
  if (requested.length === 0) {
    return {
      ok: false,
      code: "usage.missing-argument",
      message: "plugin create requires a <directory> argument.",
    };
  }

  if (requested.includes("\0")) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Directory path must not contain NUL characters.",
    };
  }

  const targetPath = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  const packageName = basename(targetPath);
  const identity = deriveIdFromPackageName(packageName);
  if (!identity.ok) {
    return {
      ok: false,
      code: identity.code,
      message: identity.message,
      details: identity.details,
    };
  }

  // Path escape / weird segments in the leaf.
  if (packageName === "." || packageName === ".." || packageName.includes("..")) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Directory name is unsafe.",
      details: { directory: packageName },
    };
  }

  const parentPath = dirname(targetPath);
  try {
    const parentStats = await stat(parentPath);
    if (!parentStats.isDirectory()) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Parent path is not a directory.",
        details: { parentPath },
      };
    }
  } catch {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Parent directory does not exist.",
      details: { parentPath },
    };
  }

  // Resolve real parent to catch symlink escape of the created leaf.
  let realParent: string;
  try {
    realParent = await realpath(parentPath);
  } catch {
    realParent = parentPath;
  }
  const resolvedTarget = join(realParent, packageName);
  if (!resolvedTarget.startsWith(realParent + sep) && resolvedTarget !== realParent) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Directory path escapes its parent.",
      details: { directory: targetPath },
    };
  }

  const destinationExists = await pathExists(targetPath);
  if (destinationExists) {
    const listing = await safeList(targetPath);
    if (listing === null) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Destination exists and is not an empty directory.",
        details: { directory: targetPath },
      };
    }
    if (listing.length > 0) {
      const collision = listing.find(
        (name) =>
          (REQUIRED_WORKSPACE_FILES as readonly string[]).includes(name) ||
          LEGACY_FORBIDDEN_NAMES.has(name) ||
          name === "dist" ||
          name === "src",
      );
      if (collision !== undefined || listing.length > 0) {
        return {
          ok: false,
          code: "plugin.source.invalid",
          message: "Destination is not empty; refusing to create a partial workspace.",
          details: { directory: targetPath, entries: listing },
        };
      }
    }
  }

  const displayName = displayNameFromId(identity.id);
  const description = `Explodex plugin ${identity.id}.`;
  const filesToWrite: Array<{ relative: string; contents: string }> = [
    { relative: "package.json", contents: packageJsonTemplate(packageName) },
    {
      relative: "explodex.config.ts",
      contents: explodexConfigTemplate({ displayName, description }),
    },
    { relative: "src/index.ts", contents: entryTemplate() },
    {
      relative: "README.md",
      contents: readmeTemplate({
        packageName,
        id: identity.id,
        displayName,
      }),
    },
    { relative: "tsconfig.json", contents: tsconfigTemplate() },
  ];
  const createdPaths: string[] = [];

  // Create root first, then optional empty dirs, then files. On any failure after
  // partial writes we still report failure; create is best-effort atomic for empty dest.
  try {
    if (options.signal?.aborted) {
      return interruptedCreate(targetPath, createdPaths);
    }
    await mkdir(targetPath, { recursive: true });
    createdPaths.push(".");
    for (const dir of OPTIONAL_EMPTY_DIRECTORIES) {
      if (options.signal?.aborted) {
        return interruptedCreate(targetPath, createdPaths);
      }
      await mkdir(join(targetPath, dir), { recursive: true });
      createdPaths.push(`${dir}/`);
    }
    if (options.signal?.aborted) {
      return interruptedCreate(targetPath, createdPaths);
    }
    await mkdir(join(targetPath, "src"), { recursive: true });
    createdPaths.push("src/");
    for (const file of filesToWrite) {
      if (options.signal?.aborted) {
        return interruptedCreate(targetPath, createdPaths);
      }
      const absolute = join(targetPath, file.relative);
      await mkdir(dirname(absolute), { recursive: true });
      // Fail if a race created the file between empty check and write.
      await writeFile(absolute, file.contents, {
        encoding: "utf8",
        flag: "wx",
        signal: options.signal,
      });
      createdPaths.push(file.relative);
    }
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      return interruptedCreate(targetPath, createdPaths);
    }
    return {
      ok: false,
      code: "plugin.source.invalid",
      message:
        error instanceof Error
          ? `Failed to create workspace: ${error.message}`
          : "Failed to create workspace.",
      details: { directory: targetPath },
    };
  }

  const created = [
    ...filesToWrite.map((file) => file.relative),
    ...OPTIONAL_EMPTY_DIRECTORIES.map((dir) => `${dir}/`),
  ];

  return {
    ok: true,
    workspacePath: targetPath,
    packageName,
    id: identity.id,
    files: created,
  };
}

function interruptedCreate(
  workspacePath: string,
  createdPaths: readonly string[],
): CreateWorkspaceResult {
  return {
    ok: false,
    code: "operation.interrupted",
    message: "Plugin workspace creation was interrupted.",
    details: {
      workspacePath,
      partialWorkspace: createdPaths.length > 0,
      createdPaths: [...createdPaths],
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function safeList(path: string): Promise<string[] | null> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) return null;
    return await readdir(path);
  } catch {
    return null;
  }
}
