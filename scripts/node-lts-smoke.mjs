#!/usr/bin/env node
/**
 * Required Node-LTS package smoke. Packs the actual CLI candidate into an
 * isolated external fixture, then imports its public runtime under Node 22 and
 * Node 24 with Bun absent from PATH. A missing required runtime is a failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = join(root, "packages", "cli");
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function miseNodeBinary(major) {
  const result = spawnSync("/usr/bin/env", ["mise", "where", `node@${major}`], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return root.length > 0 ? join(root, "bin", "node") : null;
}

function majorOf(binary) {
  const result = spawnSync(binary, ["-p", "Number(process.versions.node.split('.')[0])"], {
    encoding: "utf8",
    env: { PATH: systemPath },
  });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function requiredNode(major) {
  const override = process.env[`EXPLODEX_NODE_${major}_BIN`];
  const candidates = [
    override,
    process.execPath,
    miseNodeBinary(major),
    `/opt/homebrew/opt/node@${major}/bin/node`,
    `/usr/local/opt/node@${major}/bin/node`,
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate) && majorOf(candidate) === major) return candidate;
  }
  throw new Error(
    `Missing required Node ${major} runtime. Set EXPLODEX_NODE_${major}_BIN to a Node ${major} executable.`,
  );
}

const runtimes = [
  { label: "Node 22", binary: requiredNode(22) },
  { label: "Node 24", binary: requiredNode(24) },
];
const scratch = await mkdtemp(join(tmpdir(), "explodex-node-lts-smoke-"));
try {
  const packRoot = join(scratch, "pack");
  const packageRoot = join(scratch, "fixture", "node_modules", "explodex");
  const npmCache = join(scratch, "npm-cache");
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
  ]);
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
    cwd: cliRoot,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });
  if (packed.status !== 0) throw new Error(`CLI npm pack failed:\n${packed.stderr}`);
  const packResult = JSON.parse(packed.stdout);
  const tarball = packResult[0]?.filename;
  if (typeof tarball !== "string") throw new Error("CLI npm pack returned no tarball filename");
  const extracted = spawnSync("tar", [
    "-xzf",
    join(packRoot, tarball),
    "-C",
    packageRoot,
    "--strip-components=1",
  ], { encoding: "utf8", env: { PATH: systemPath } });
  if (extracted.status !== 0) throw new Error(`CLI tar extraction failed:\n${extracted.stderr}`);

  const probe = join(scratch, "fixture", "probe.mjs");
  await writeFile(probe, `
import { LOCK_ACQUISITION_BOUND_MS, createSystemRuntimeClock } from "explodex/runtime";
const bunAbsent = !(process.env.PATH || "").split(":").some((part) => part.toLowerCase().includes("bun"));
if (!bunAbsent) throw new Error("Bun unexpectedly present in runtime PATH");
if (LOCK_ACQUISITION_BOUND_MS !== 2000) throw new Error("Unexpected lock bound");
console.log(JSON.stringify({ runtime: process.version, bunAbsent, nowType: typeof createSystemRuntimeClock().nowMs() }));
`, { mode: 0o600 });

  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== "explodex") throw new Error("Packed CLI package name mismatch");
  for (const runtime of runtimes) {
    const result = spawnSync(runtime.binary, [probe], {
      cwd: dirname(probe),
      encoding: "utf8",
      env: {
        PATH: systemPath,
        HOME: join(scratch, `home-${runtime.label.replace(" ", "-")}`),
        npm_config_cache: join(scratch, `cache-${runtime.label.replace(" ", "-")}`),
      },
    });
    if (result.status !== 0) {
      throw new Error(`${runtime.label} packed runtime smoke failed:\n${result.stderr}`);
    }
    console.log(`[node-lts-smoke] ${runtime.label}: ${result.stdout.trim()}`);
  }
  console.log(`[node-lts-smoke] package=${packageJson.name}@${packageJson.version}`);
  console.log("[node-lts-smoke] ok");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
