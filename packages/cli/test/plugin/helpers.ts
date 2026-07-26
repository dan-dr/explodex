import { mkdir, mkdtemp, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginWorkspace } from "../../src/plugin/create.ts";

export const CLI_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SDK_PACKAGE_ROOT = join(CLI_PACKAGE_ROOT, "..", "sdk");
export const SDK_DIST = join(SDK_PACKAGE_ROOT, "dist");

export async function tempDir(prefix = "explodex-plugin-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Install a local file-linked @explodex/sdk into a workspace so config loading resolves.
 */
export async function linkSdkIntoWorkspace(workspacePath: string): Promise<void> {
  const target = join(workspacePath, "node_modules", "@explodex", "sdk");
  await mkdir(dirname(target), { recursive: true });
  // Copy package.json + dist so Node can resolve without monorepo workspace protocol.
  await mkdir(target, { recursive: true });
  await cp(join(SDK_PACKAGE_ROOT, "package.json"), join(target, "package.json"));
  await cp(SDK_DIST, join(target, "dist"), { recursive: true });
}

export async function createValidWorkspace(options?: {
  name?: string;
  withDist?: boolean;
}): Promise<{ root: string; workspace: string; cleanup: () => Promise<void> }> {
  const root = await tempDir();
  const name = options?.name ?? "explodex-plugin-sample";
  const result = await createPluginWorkspace({
    directory: join(root, name),
    cwd: root,
  });
  if (!result.ok) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`create failed: ${result.message}`);
  }
  await linkSdkIntoWorkspace(result.workspacePath);
  if (options?.withDist) {
    await mkdir(join(result.workspacePath, "dist"), { recursive: true });
    await writeFile(join(result.workspacePath, "dist", "index.js"), "/* prior dist */\n");
  }
  return {
    root,
    workspace: result.workspacePath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeWorkspaceFile(
  workspace: string,
  relative: string,
  contents: string,
): Promise<void> {
  const absolute = join(workspace, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}
