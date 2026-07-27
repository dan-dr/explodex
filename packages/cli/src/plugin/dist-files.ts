/**
 * Installable dist path vocabulary and whole-tree fingerprinting.
 */

import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  comparePayloadPathsByUtf8Bytes,
  PayloadPathTopologyTracker,
  validateNormalizedPayloadPath,
  type PayloadPathKind,
} from "./payload-path.ts";

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
  const validated = validateNormalizedPayloadPath(relative, { kind: "file" });
  if (!validated.ok) return false;
  if (relative === GENERATION_FILE) return false;
  if (relative.startsWith(".explodex-")) return false;
  if (INSTALLABLE_ROOT_FILES.includes(relative as (typeof INSTALLABLE_ROOT_FILES)[number])) {
    return true;
  }
  return relative.startsWith("assets/");
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
  return comparePayloadPathsByUtf8Bytes(a, b);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type PayloadTreeEntry = {
  path: string;
  kind: PayloadPathKind;
};

export async function listPayloadTreeEntries(
  root: string,
  prefix = "",
  topology = new PayloadPathTopologyTracker(),
): Promise<PayloadTreeEntry[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error: unknown) {
    if (prefix.length > 0) throw error;
    return [];
  }
  const out: PayloadTreeEntry[] = [];
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const kind: PayloadPathKind = entry.isDirectory() ? "directory" : "file";
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`Payload contains a special filesystem entry: ${relative}`);
    }
    const validated = validateNormalizedPayloadPath(relative, { kind });
    if (!validated.ok) throw new Error(validated.message);
    const topologyFailure = topology.add(validated.validated, kind);
    if (topologyFailure !== null) throw new Error(topologyFailure.message);
    if (entry.isDirectory()) {
      out.push({ path: validated.validated.path, kind });
      out.push(...(await listPayloadTreeEntries(root, validated.validated.path, topology)));
    } else {
      out.push({ path: validated.validated.path, kind });
    }
  }
  return out.sort((left, right) => compareBytewise(left.path, right.path));
}

async function listFilesRecursive(root: string): Promise<string[]> {
  return (await listPayloadTreeEntries(root))
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path);
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
