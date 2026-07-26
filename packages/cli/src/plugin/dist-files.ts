/**
 * Installable dist path vocabulary and whole-tree fingerprinting.
 */

import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Private generation binding file; not part of the installable payload. */
export const GENERATION_FILE = ".explodex-generation.json";

/** Required root installable files for a V1 dist. */
export const INSTALLABLE_ROOT_FILES = [
  "index.js",
  "index.js.map",
  "plugin.json",
  "checksums.json",
] as const;

export function isInstallableRelativePath(relative: string): boolean {
  if (relative === GENERATION_FILE) return false;
  if (relative.startsWith(".explodex-")) return false;
  if (INSTALLABLE_ROOT_FILES.includes(relative as (typeof INSTALLABLE_ROOT_FILES)[number])) {
    return true;
  }
  return relative === "assets" || relative.startsWith("assets/");
}

export async function listDistFiles(distPath: string): Promise<string[]> {
  return listFilesRecursive(distPath);
}

export async function listInstallableFiles(distPath: string): Promise<string[]> {
  const all = await listFilesRecursive(distPath);
  return all.filter((relative) => isInstallableRelativePath(relative)).sort(compareBytewise);
}

/** Stable whole-tree fingerprint of dist/, including private generation metadata. */
export async function fingerprintDistTree(workspacePath: string): Promise<string | null> {
  const distPath = join(resolve(workspacePath), "dist");
  if (!(await pathExists(distPath))) return null;
  const hash = createHash("sha256");
  const files = await listFilesRecursive(distPath);
  files.sort(compareBytewise);
  for (const relative of files) {
    const bytes = await readFile(join(distPath, relative));
    hash.update(relative);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function compareBytewise(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listFilesRecursive(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(root, relative)));
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function distDirectoryExists(workspacePath: string): Promise<boolean> {
  try {
    const stats = await stat(join(resolve(workspacePath), "dist"));
    return stats.isDirectory();
  } catch {
    return false;
  }
}
