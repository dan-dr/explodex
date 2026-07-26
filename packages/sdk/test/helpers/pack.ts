import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const SDK_PACKAGE_ROOT = join(import.meta.dir, "..", "..");
export const REPO_ROOT = join(SDK_PACKAGE_ROOT, "..", "..");

export type PackListing = {
  id: string;
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string; size: number }>;
};

export async function buildSdkPackage(): Promise<void> {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: SDK_PACKAGE_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(build.stderr).text();
    throw new Error(`SDK build failed (${exitCode}): ${stderr}`);
  }
}

export async function packSdkDryRun(): Promise<PackListing> {
  const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
    cwd: SDK_PACKAGE_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`npm pack --dry-run failed: ${stderr || stdout}`);
  }
  const parsed = JSON.parse(stdout) as PackListing[];
  const listing = parsed[0];
  if (listing === undefined) {
    throw new Error("npm pack --dry-run returned no package listing");
  }
  return listing;
}

export async function packSdkActual(destinationDir: string): Promise<{
  tarballPath: string;
  listing: PackListing;
}> {
  await mkdir(destinationDir, { recursive: true });
  const proc = Bun.spawn(["npm", "pack", "--json", "--pack-destination", destinationDir], {
    cwd: SDK_PACKAGE_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`npm pack failed: ${stderr || stdout}`);
  }
  const parsed = JSON.parse(stdout) as PackListing[];
  const listing = parsed[0];
  if (listing === undefined) {
    throw new Error("npm pack returned no package listing");
  }
  const tarballPath = join(destinationDir, listing.filename);
  return { tarballPath, listing };
}

/**
 * Minimal ustar/pax-aware path extractor for npm pack tarballs.
 * npm pack produces gzipped tar; entries are typically `package/...`.
 */
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

export async function installSdkFromTarball(
  tarballPath: string,
): Promise<{ consumerRoot: string; cleanup: () => Promise<void> }> {
  const consumerRoot = await mkdtemp(join(tmpdir(), "explodex-sdk-consumer-"));
  const packageJson = {
    name: "explodex-sdk-external-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@explodex/sdk": `file:${tarballPath}`,
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

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
