import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const CLI_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SDK_PACKAGE_ROOT = join(CLI_PACKAGE_ROOT, "..", "sdk");
export const REPO_ROOT = join(CLI_PACKAGE_ROOT, "..", "..");

export const FIRST_PARTY_PLUGIN_IDS = [
  "explodex-plugin-command-menu-threads",
  "explodex-plugin-effort-shortcuts",
  "explodex-plugin-feature-flags-playground",
  "explodex-plugin-project-colors",
  "explodex-plugin-project-pins",
  "explodex-plugin-toggle-autoscroll",
  "explodex-plugin-usage-reset-glance",
] as const;

export const PAYLOAD_SENTINELS = [
  "plugin-registry",
  "FIRST_PARTY_PLUGIN",
  "__EXPLODEX_PLUGIN_CATALOG__",
  "explodex-plugin-",
] as const;

export type PackListing = {
  id: string;
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string; size: number }>;
};

export async function buildPackage(packageRoot: string): Promise<void> {
  // Use the package build wrapper so npm-injected PATH shadows of incomplete
  // node_modules/.bin/bun cannot take over during later pack/prepack.
  const build = Bun.spawn(["bash", "./scripts/run-build.sh"], {
    cwd: packageRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${process.env.HOME ?? ""}/.bun/bin:${process.env.PATH ?? ""}`,
    },
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(build.stderr).text();
    throw new Error(`build failed in ${packageRoot} (${exitCode}): ${stderr}`);
  }
}

export async function packActual(
  packageRoot: string,
  destinationDir: string,
): Promise<{ tarballPath: string; listing: PackListing }> {
  await mkdir(destinationDir, { recursive: true });
  const proc = Bun.spawn(["npm", "pack", "--json", "--pack-destination", destinationDir], {
    cwd: packageRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`npm pack failed in ${packageRoot}: ${stderr || stdout}`);
  }
  const parsed = JSON.parse(stdout) as PackListing[];
  const listing = parsed[0];
  if (listing === undefined) throw new Error("npm pack returned no listing");
  return { tarballPath: join(destinationDir, listing.filename), listing };
}

export async function listTarballPaths(tarballPath: string): Promise<string[]> {
  const gz = await readFile(tarballPath);
  const tar = gunzipSync(gz);
  const paths: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const sizeOctal = readTarString(header, 124, 12);
    const size = Number.parseInt(sizeOctal, 8) || 0;
    const prefix = readTarString(header, 345, 155);
    const full = prefix.length > 0 ? `${prefix}/${name}` : name;
    if (full.length > 0) paths.push(full);
    const dataBlocks = Math.ceil(size / 512);
    offset += 512 + dataBlocks * 512;
  }
  return paths;
}

function readTarString(header: Uint8Array, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end < 0) end = slice.length;
  return Buffer.from(slice.subarray(0, end)).toString("utf8").trim();
}

export async function installSdkAndCli(options: {
  sdkTarball: string;
  cliTarball: string;
}): Promise<{ consumerRoot: string; cleanup: () => Promise<void> }> {
  const consumerRoot = await mkdtemp(join(tmpdir(), "explodex-cli-consumer-"));
  const packageJson = {
    name: "explodex-cli-external-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@explodex/sdk": `file:${options.sdkTarball}`,
      explodex: `file:${options.cliTarball}`,
    },
  };
  await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const install = Bun.spawn(
    ["npm", "install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"],
    {
      cwd: consumerRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        npm_config_ignore_scripts: "true",
      },
    },
  );
  const exitCode = await install.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(install.stderr).text();
    await rm(consumerRoot, { recursive: true, force: true });
    throw new Error(`npm install failed: ${stderr}`);
  }
  return {
    consumerRoot,
    cleanup: async () => {
      await rm(consumerRoot, { recursive: true, force: true });
    },
  };
}

export function miseNodeBinary(major: 22 | 24): string {
  const result = Bun.spawnSync(["mise", "where", `node@${major}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`mise where node@${major} failed`);
  }
  const root = result.stdout.toString("utf8").trim();
  return join(root, "bin", "node");
}

export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
