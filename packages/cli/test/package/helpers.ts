import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isAbsolute, posix } from "node:path";
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
  "FIRST_PARTY_PLUGIN_PAYLOAD_SENTINEL",
  "explodex-plugin-",
] as const;

export type PackListing = {
  id: string;
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string; size: number }>;
};

export type AuditedTarEntry =
  | { path: string; type: "file"; bytes: Buffer }
  | { path: string; type: "directory"; bytes: Buffer };

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
    env: { ...process.env, NPM_CONFIG_CACHE: join(destinationDir, ".npm-cache") },
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
  const audit = await auditTarballEntries(tarballPath);
  return audit.entries.map((entry) => entry.path);
}

export async function auditTarballEntries(
  tarballPath: string,
): Promise<{ entries: AuditedTarEntry[] }> {
  const gz = await readFile(tarballPath);
  const tar = gunzipSync(gz);
  const entries: AuditedTarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks !== 0) {
      throw new Error("Tarball contains a non-zero entry after an end marker.");
    }
    const name = readTarStringFatal(header, 0, 100);
    const sizeOctal = readTarStringFatal(header, 124, 12);
    const size = parseTarOctal(sizeOctal, "size");
    const prefix = readTarStringFatal(header, 345, 155);
    const full = prefix.length > 0 ? `${prefix}/${name}` : name;
    assertSafePackagePath(full);
    if (seen.has(full)) throw new Error(`Tarball contains duplicate path: ${full}`);
    seen.add(full);
    const typeFlag = header[156] ?? 0;
    const type = typeFlag === 0 || typeFlag === 0x30
      ? "file"
      : typeFlag === 0x35
        ? "directory"
        : null;
    if (type === null) {
      const linkPath = readTarStringFatal(header, 157, 100);
      throw new Error(
        `Tarball contains unsupported link or special entry type ${String.fromCharCode(typeFlag)} at ${full}${linkPath.length === 0 ? "" : ` -> ${linkPath}`}.`,
      );
    }
    if (type === "directory" && size !== 0) {
      throw new Error(`Tarball directory entry has non-zero size: ${full}`);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) {
      throw new Error(`Tarball entry exceeds archive bytes: ${full}`);
    }
    const bytes = Buffer.from(tar.subarray(dataStart, dataEnd));
    entries.push({ path: full, type, bytes });
    const dataBlocks = Math.ceil(size / 512);
    offset += 512 + dataBlocks * 512;
  }
  if (zeroBlocks < 2) throw new Error("Tarball is missing the complete end marker.");
  return { entries };
}

function readTarStringFatal(
  header: Uint8Array,
  start: number,
  length: number,
): string {
  const slice = header.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end < 0) end = slice.length;
  return new TextDecoder("utf-8", { fatal: true })
    .decode(slice.subarray(0, end));
}

function parseTarOctal(value: string, field: string): number {
  const trimmed = value.trim();
  if (!/^[0-7]+$/.test(trimmed)) {
    throw new Error(`Tarball ${field} is not canonical octal.`);
  }
  const parsed = Number.parseInt(trimmed, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Tarball ${field} is outside the supported range.`);
  }
  return parsed;
}

function assertSafePackagePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error(`Tarball contains unsafe path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    segments[0] !== "package" ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`Tarball path escapes the package root: ${path}`);
  }
}

export async function installSdkAndCli(options: {
  sdkTarball: string;
  cliTarball: string;
  dependencyTarballs?: Record<string, string>;
  home?: string;
  offline?: boolean;
}): Promise<{ consumerRoot: string; cleanup: () => Promise<void> }> {
  const consumerRoot = await mkdtemp(join(tmpdir(), "explodex-cli-consumer-"));
  const dependencyTarballs = options.dependencyTarballs ??
    await packRuntimeDependencyClosure(join(consumerRoot, ".dependency-packs"));
  const offline = options.offline ?? true;
  const packageJson = {
    name: "explodex-cli-external-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@explodex/sdk": `file:${options.sdkTarball}`,
      explodex: `file:${options.cliTarball}`,
      ...Object.fromEntries(
        Object.entries(dependencyTarballs).map(([name, path]) => [
          name,
          `file:${path}`,
        ]),
      ),
    },
  };
  await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const install = Bun.spawn(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      ...(offline ? ["--offline"] : []),
    ],
    {
      cwd: consumerRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: options.home ?? process.env.HOME,
        npm_config_cache: join(consumerRoot, ".npm-cache"),
        npm_config_ignore_scripts: "true",
        ...(offline
          ? {
              npm_config_offline: "true",
              npm_config_registry: "http://127.0.0.1:9/",
            }
          : {}),
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

export async function packRuntimeDependencyClosure(
  destinationDir: string,
): Promise<Record<string, string>> {
  const esbuildPackageRoot = await realpath(join(REPO_ROOT, "node_modules", "esbuild"));
  const esbuildPlatformPackage = join(
    dirname(esbuildPackageRoot),
    "@esbuild",
    `${process.platform}-${process.arch}`,
  );
  const dependencies = [
    ["acorn", join(REPO_ROOT, "node_modules", "acorn")],
    ["esbuild", join(REPO_ROOT, "node_modules", "esbuild")],
    [
      `@esbuild/${process.platform}-${process.arch}`,
      esbuildPlatformPackage,
    ],
  ] as const;
  const packed: Record<string, string> = {};
  for (const [name, packageRoot] of dependencies) {
    const destination = join(
      destinationDir,
      name.replaceAll("/", "__").replaceAll("@", ""),
    );
    await mkdir(destination, { recursive: true });
    const stage = await mkdtemp(join(destination, "stage-"));
    const packageStage = join(stage, "package");
    const tarballPath = join(
      destination,
      `${name.replaceAll("/", "-").replaceAll("@", "")}.tgz`,
    );
    try {
      await cp(packageRoot, packageStage, {
        recursive: true,
        dereference: true,
        preserveTimestamps: true,
      });
      const proc = Bun.spawn(
        ["tar", "-czf", tarballPath, "-C", stage, "package"],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(
          `tar failed for ${name}: ${await new Response(proc.stderr).text()}`,
        );
      }
      packed[name] = tarballPath;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  return packed;
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
