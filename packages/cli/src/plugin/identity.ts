import { basename, resolve } from "node:path";

const PACKAGE_NAME_PATTERN = /^explodex-plugin-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export type IdentityDerivation =
  | {
      ok: true;
      id: string;
      packageName: string;
      workspacePath: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

/**
 * Derive runtime plugin ID from a canonical folder basename `explodex-plugin-NAME`.
 * NAME is lowercase alphanumerics with single hyphen separators.
 */
export function deriveIdFromPackageName(packageName: unknown): IdentityDerivation {
  if (typeof packageName !== "string" || packageName.length === 0) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Plugin package name must be a non-empty string matching explodex-plugin-<name>.",
      details: { packageName },
    };
  }
  const match = PACKAGE_NAME_PATTERN.exec(packageName);
  if (match === null || match[1] === undefined) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message:
        "Plugin package/folder name must match explodex-plugin-<name> with lowercase alphanumerics and hyphens.",
      details: { packageName },
    };
  }
  return {
    ok: true,
    id: match[1],
    packageName,
    workspacePath: "",
  };
}

/**
 * Derive identity from a workspace path's final directory segment.
 */
export function deriveIdFromWorkspacePath(workspacePath: string): IdentityDerivation {
  const absolute = resolve(workspacePath);
  const packageName = basename(absolute);
  const derived = deriveIdFromPackageName(packageName);
  if (!derived.ok) return derived;
  return {
    ok: true,
    id: derived.id,
    packageName: derived.packageName,
    workspacePath: absolute,
  };
}

/**
 * Require matching folder basename and package.json name, then derive ID.
 */
export function deriveMatchingIdentity(options: {
  workspacePath: string;
  packageName: unknown;
}): IdentityDerivation {
  const fromPath = deriveIdFromWorkspacePath(options.workspacePath);
  if (!fromPath.ok) return fromPath;
  const fromPackage = deriveIdFromPackageName(options.packageName);
  if (!fromPackage.ok) return fromPackage;
  if (fromPath.packageName !== fromPackage.packageName) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Folder name and package.json name must match exactly.",
      details: {
        folderName: fromPath.packageName,
        packageName: fromPackage.packageName,
      },
    };
  }
  return {
    ok: true,
    id: fromPath.id,
    packageName: fromPath.packageName,
    workspacePath: fromPath.workspacePath,
  };
}

/** Title-case display name from derived ID (hello-world → Hello World). */
export function displayNameFromId(id: string): string {
  return id
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
