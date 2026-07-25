/**
 * Package-derived Darwin advisory-lease evidence for VAL-HOST-027/028/029.
 * Packs the CLI candidate, extracts it into an external fixture, compiles only
 * this fixture outside the package, and drives the exported runtime under the
 * required Node 22 and Node 24 runtimes with Bun absent from PATH.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const CLI_PACKAGE_ROOT = join(REPOSITORY_ROOT, "packages", "cli");
const WORKER_SOURCE = join(import.meta.dir, "packed-darwin-lock-worker.ts");
const WORKER_OUTPUT_RELATIVE = "packed-darwin-lock-worker.js";
const TSC = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsc");
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

type RequiredNode = { label: "Node 22" | "Node 24"; major: 22 | 24; binary: string };
type WorkerOptions = {
  node: RequiredNode;
  fixtureRoot: string;
  home: string;
  command: "hold" | "try" | "bounded-wait" | "hold-after-spawn" | "race";
  operationId: string;
  readyFile?: string;
  releaseFile?: string;
  childLog?: string;
  waitMs?: number;
  publicationBarrier?: string;
};
type WorkerOutput = {
  ok: boolean;
  pid: number;
  elapsedMs: number;
  bunAbsentFromPath: boolean;
  publication?: "published" | "lost-race" | "existing";
  code?: string;
  stage?: string | null;
  boundMs?: number;
  leasePath?: string;
  leaseDevice?: string;
  leaseInode?: string;
  closeOnExec?: boolean;
  recoveredStale?: boolean;
  released?: boolean;
  handleState?: {
    descriptorOpen: boolean;
    leaseHeld: boolean;
    releasedMetadataWritten: boolean;
  };
  error?: { code: string; stage: string | null; boundMs?: number };
  residualInventory?: {
    commandOwnedChildren: number;
    locksHeld: number;
    openLockDescriptors: number;
    advisoryLeasesHeld: number;
    hasResidentControlPlane: boolean;
  };
};

type CollectedWorker = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  result: WorkerOutput;
};

function miseNodeBinary(major: 22 | 24): string | null {
  const mise = spawnSync("/usr/bin/env", ["mise", "where", `node@${major}`], {
    encoding: "utf8",
    env: process.env,
  });
  if (mise.status !== 0) return null;
  const root = mise.stdout.trim();
  return root.length > 0 ? join(root, "bin", "node") : null;
}

function nodeMajor(binary: string): number | null {
  const result = spawnSync(binary, ["-p", "Number(process.versions.node.split('.')[0])"], {
    encoding: "utf8",
    env: { PATH: SYSTEM_PATH },
  });
  if (result.status !== 0) return null;
  const major = Number(result.stdout.trim());
  return Number.isInteger(major) ? major : null;
}

function resolveRequiredNode(major: 22 | 24): RequiredNode {
  const envOverride = process.env[`EXPLODEX_NODE_${major}_BIN`];
  const candidates = [
    envOverride,
    process.execPath,
    miseNodeBinary(major),
    `/opt/homebrew/opt/node@${major}/bin/node`,
    `/usr/local/opt/node@${major}/bin/node`,
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (nodeMajor(candidate) === major) {
      return { label: `Node ${major}` as "Node 22" | "Node 24", major, binary: candidate };
    }
  }
  throw new Error(
    `Missing required Node ${major} runtime. Set EXPLODEX_NODE_${major}_BIN to an executable Node ${major} binary.`,
  );
}

const REQUIRED_NODES = [resolveRequiredNode(22), resolveRequiredNode(24)];

function workerEnvironment(options: WorkerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: SYSTEM_PATH,
    HOME: join(options.fixtureRoot, "isolated-home"),
    TMPDIR: join(options.fixtureRoot, "tmp"),
    npm_config_cache: join(options.fixtureRoot, "npm-cache-runtime"),
    EXPLODEX_WORKER_HOME: options.home,
    EXPLODEX_WORKER_OPERATION_ID: options.operationId,
  };
  if (options.readyFile !== undefined) env.EXPLODEX_WORKER_READY_FILE = options.readyFile;
  if (options.releaseFile !== undefined) env.EXPLODEX_WORKER_RELEASE_FILE = options.releaseFile;
  if (options.childLog !== undefined) env.EXPLODEX_WORKER_CHILD_LOG = options.childLog;
  if (options.waitMs !== undefined) env.EXPLODEX_WORKER_WAIT_MS = String(options.waitMs);
  if (options.publicationBarrier !== undefined) {
    env.EXPLODEX_WORKER_PUBLICATION_BARRIER = options.publicationBarrier;
    env.EXPLODEX_WORKER_PUBLICATION_PEERS = "2";
  }
  return env;
}

function spawnWorker(options: WorkerOptions): ChildProcess {
  return spawn(options.node.binary, [
    join(options.fixtureRoot, "external", WORKER_OUTPUT_RELATIVE),
    options.command,
  ], {
    cwd: join(options.fixtureRoot, "external"),
    env: workerEnvironment(options),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timeout waiting for file: ${path}`);
}

async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidExit(pid: number, timeoutMs = 3_000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PID ${pid} remained alive after ${timeoutMs}ms`);
}

function signalExactTestProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
}

async function stopExactTestProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || !await pidAlive(child.pid)) return;
  signalExactTestProcess(child, "SIGTERM");
  await waitPidExit(child.pid);
}

async function stopExactPid(pid: number): Promise<void> {
  if (!await pidAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  await waitPidExit(pid);
}

async function collectWorker(child: ChildProcess, timeoutMs = 8_000): Promise<CollectedWorker> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      signalExactTestProcess(child, "SIGTERM");
      reject(new Error(`Worker PID ${child.pid ?? "unknown"} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  if (child.pid !== undefined) await waitPidExit(child.pid);
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`Worker emitted no JSON. stderr=${stderr}`);
  return { stdout, stderr, exitCode, result: JSON.parse(line) as WorkerOutput };
}

async function descriptorInventory(leasePath: string): Promise<string[]> {
  const result = spawnSync("/usr/sbin/lsof", ["-n", "-F", "pcf", "--", leasePath], {
    encoding: "utf8",
    env: { PATH: SYSTEM_PATH },
  });
  if (result.status === 1 && result.stdout.length === 0) return [];
  if (result.status !== 0) {
    throw new Error(`lsof failed for ${leasePath}: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

async function helperInventory(fixtureRoot: string): Promise<string[]> {
  const helperPath = join(
    fixtureRoot,
    "external",
    "node_modules",
    "explodex",
    "dist",
    "runtime",
    "bin",
    "explodex-runtime-helper",
  );
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    env: { PATH: SYSTEM_PATH },
  });
  if (result.status !== 0) throw new Error(`ps inventory failed: ${result.stderr.trim()}`);
  return result.stdout.split("\n").filter((line) => line.includes(helperPath));
}

async function buildExternalFixture(root: string): Promise<void> {
  const externalRoot = join(root, "external");
  const packageRoot = join(externalRoot, "node_modules", "explodex");
  const packageCache = join(root, "npm-cache-pack");
  const packRoot = join(root, "pack");
  await Promise.all([
    mkdir(externalRoot, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(packageCache, { recursive: true }),
    mkdir(packRoot, { recursive: true }),
    mkdir(join(root, "isolated-home"), { recursive: true }),
    mkdir(join(root, "tmp"), { recursive: true }),
  ]);

  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
    cwd: CLI_PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: packageCache },
  });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
  const filename = packed[0]?.filename;
  if (filename === undefined) throw new Error("npm pack did not report a tarball filename");
  const extraction = spawnSync("tar", [
    "-xzf",
    join(packRoot, filename),
    "-C",
    packageRoot,
    "--strip-components=1",
  ], { encoding: "utf8", env: { PATH: SYSTEM_PATH } });
  if (extraction.status !== 0) throw new Error(`tar extraction failed: ${extraction.stderr}`);

  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  expect(packageJson.exports?.["./runtime"]).toBeDefined();
  expect(await stat(join(packageRoot, "dist", "runtime", "index.js"))).toBeDefined();
  expect(await stat(join(packageRoot, "dist", "runtime", "bin", "explodex-runtime-helper")))
    .toBeDefined();

  const bunTypesLink = join(root, "external-bun-types");
  await symlink(join(REPOSITORY_ROOT, "node_modules", "bun-types"), bunTypesLink);
  await writeFile(join(externalRoot, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023"],
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: false,
      rootDir: dirname(WORKER_SOURCE),
      outDir: externalRoot,
      types: [bunTypesLink],
    },
    include: [WORKER_SOURCE],
  }, null, 2)}\n`, { mode: 0o600 });
  const compilation = spawnSync(REQUIRED_NODES[0].binary, [
    TSC,
    "-p",
    join(externalRoot, "tsconfig.json"),
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { PATH: SYSTEM_PATH },
  });
  if (compilation.status !== 0) {
    throw new Error(`External worker compilation failed:\n${compilation.stdout}\n${compilation.stderr}`);
  }
  expect(await stat(join(externalRoot, WORKER_OUTPUT_RELATIVE))).toBeDefined();
  await writeFile(join(externalRoot, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
}

async function freshHome(root: string, node: RequiredNode, scenario: string): Promise<string> {
  const home = join(root, `home-node${node.major}-${scenario}`);
  await mkdir(home, { recursive: true });
  return home;
}

function assertCleanWorkerResult(result: WorkerOutput): void {
  expect(result.bunAbsentFromPath).toBe(true);
  if (result.residualInventory !== undefined) {
    expect(result.residualInventory.commandOwnedChildren).toBe(0);
    expect(result.residualInventory.locksHeld).toBe(0);
    expect(result.residualInventory.openLockDescriptors).toBe(0);
    expect(result.residualInventory.advisoryLeasesHeld).toBe(0);
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
  }
}

describe("packed Darwin advisory-lease protocol under required Node runtimes", () => {
  let fixtureRoot: string;
  const recordedPids = new Set<number>();
  const recordedLeasePaths = new Set<string>();

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "explodex-packed-lock-"));
    await buildExternalFixture(fixtureRoot);
  }, 30_000);

  afterAll(async () => {
    for (const pid of recordedPids) {
      if (await pidAlive(pid)) await stopExactPid(pid);
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  for (const node of REQUIRED_NODES) {
    describe(`${node.label} package-derived evidence`, () => {
      test("real kernel contention and holder-death release", async () => {
        const home = await freshHome(fixtureRoot, node, "contention");
        const readyFile = join(home, "holder-ready.json");
        const holder = spawnWorker({
          node,
          fixtureRoot,
          home,
          command: "hold",
          operationId: `node${node.major}-holder`,
          readyFile,
        });
        if (holder.pid !== undefined) recordedPids.add(holder.pid);
        try {
          const ready = JSON.parse(await waitForFile(readyFile)) as WorkerOutput;
          expect(ready.closeOnExec).toBe(true);
          expect(ready.leaseInode).toBeDefined();
          if (ready.leasePath !== undefined) recordedLeasePaths.add(ready.leasePath);

          const busy = await collectWorker(spawnWorker({
            node,
            fixtureRoot,
            home,
            command: "try",
            operationId: `node${node.major}-busy`,
          }));
          expect(busy.exitCode).toBe(2);
          expect(busy.result.ok).toBe(false);
          expect(busy.result.code).toBe("lock_busy");
          expect(busy.result.stage).toBe("lock-acquisition");
          expect(busy.result.boundMs).toBe(0);
          assertCleanWorkerResult(busy.result);

          await stopExactTestProcess(holder);
          const recovered = await collectWorker(spawnWorker({
            node,
            fixtureRoot,
            home,
            command: "try",
            operationId: `node${node.major}-recovered`,
          }));
          expect(recovered.exitCode).toBe(0);
          expect(recovered.result.ok).toBe(true);
          expect(recovered.result.recoveredStale).toBe(true);
          expect(recovered.result.leaseInode).toBe(ready.leaseInode);
          expect(recovered.result.handleState).toEqual({
            descriptorOpen: false,
            leaseHeld: false,
            releasedMetadataWritten: true,
          });
          assertCleanWorkerResult(recovered.result);
        } finally {
          await stopExactTestProcess(holder);
        }
      });

      test("exec boundary does not transfer the FD_CLOEXEC lease", async () => {
        const home = await freshHome(fixtureRoot, node, "cloexec");
        const childLog = join(home, "exec-child.pid");
        const holder = spawnWorker({
          node,
          fixtureRoot,
          home,
          command: "hold-after-spawn",
          operationId: `node${node.major}-cloexec-holder`,
          childLog,
        });
        if (holder.pid !== undefined) recordedPids.add(holder.pid);
        const holderResult = await collectWorker(holder);
        expect(holderResult.exitCode).toBe(0);
        const execChildPid = Number((await readFile(childLog, "utf8")).trim());
        recordedPids.add(execChildPid);
        expect(await pidAlive(execChildPid)).toBe(true);
        try {
          const contender = await collectWorker(spawnWorker({
            node,
            fixtureRoot,
            home,
            command: "try",
            operationId: `node${node.major}-cloexec-contender`,
          }));
          expect(contender.exitCode).toBe(0);
          expect(contender.result.ok).toBe(true);
          expect(contender.result.recoveredStale).toBe(true);
          assertCleanWorkerResult(contender.result);
        } finally {
          await stopExactPid(execChildPid);
        }
      });

      test("SIGINT and finite timeout return structured lock-stage outcomes", async () => {
        const home = await freshHome(fixtureRoot, node, "bounded");
        const readyFile = join(home, "holder-ready.json");
        const holder = spawnWorker({
          node,
          fixtureRoot,
          home,
          command: "hold",
          operationId: `node${node.major}-bounded-holder`,
          readyFile,
        });
        if (holder.pid !== undefined) recordedPids.add(holder.pid);
        try {
          await waitForFile(readyFile);
          const interruptedChild = spawnWorker({
            node,
            fixtureRoot,
            home,
            command: "bounded-wait",
            operationId: `node${node.major}-interrupted`,
            waitMs: 5_000,
          });
          if (interruptedChild.pid !== undefined) recordedPids.add(interruptedChild.pid);
          await new Promise((resolve) => setTimeout(resolve, 150));
          signalExactTestProcess(interruptedChild, "SIGINT");
          const interrupted = await collectWorker(interruptedChild);
          expect(interrupted.exitCode).toBe(130);
          expect(interrupted.result.ok).toBe(false);
          expect(interrupted.result.error?.code).toBe("operation_interrupted");
          expect(interrupted.result.error?.stage).toBe("lock-acquisition");
          assertCleanWorkerResult(interrupted.result);

          const declaredBoundMs = 200;
          const timed = await collectWorker(spawnWorker({
            node,
            fixtureRoot,
            home,
            command: "bounded-wait",
            operationId: `node${node.major}-timeout`,
            waitMs: declaredBoundMs,
          }));
          expect(timed.exitCode).toBe(2);
          expect(timed.result.ok).toBe(false);
          expect(timed.result.error?.code).toBe("operation_timeout");
          expect(timed.result.error?.stage).toBe("lock-acquisition");
          expect(timed.result.error?.boundMs).toBe(declaredBoundMs);
          expect(timed.result.elapsedMs).toBeGreaterThanOrEqual(declaredBoundMs - 25);
          expect(timed.result.elapsedMs).toBeLessThan(2_000);
          assertCleanWorkerResult(timed.result);
        } finally {
          await stopExactTestProcess(holder);
        }
      });

      test("two synchronized first-time publishers preserve one canonical inode", async () => {
        const home = await freshHome(fixtureRoot, node, "publication");
        const barrier = join(home, "publication-barrier");
        const releaseOne = join(home, "release-one");
        const releaseTwo = join(home, "release-two");
        await mkdir(barrier, { recursive: true });
        const first = spawnWorker({
          node,
          fixtureRoot,
          home,
          command: "race",
          operationId: `node${node.major}-publisher-one`,
          releaseFile: releaseOne,
          publicationBarrier: barrier,
          waitMs: 2_000,
        });
        const second = spawnWorker({
          node,
          fixtureRoot,
          home,
          command: "race",
          operationId: `node${node.major}-publisher-two`,
          releaseFile: releaseTwo,
          publicationBarrier: barrier,
          waitMs: 2_000,
        });
        if (first.pid !== undefined) recordedPids.add(first.pid);
        if (second.pid !== undefined) recordedPids.add(second.pid);
        try {
          await waitForFile(join(barrier, `publisher-${first.pid ?? 0}`));
          await waitForFile(join(barrier, `publisher-${second.pid ?? 0}`));
          const canonicalLease = join(home, "locks", "plugins-state.lock", "lease");
          const canonicalInode = (await stat(canonicalLease, { bigint: true })).ino.toString();
          await writeFile(releaseOne, "release\n", { mode: 0o600 });
          const firstResult = await collectWorker(first);
          await writeFile(releaseTwo, "release\n", { mode: 0o600 });
          const secondResult = await collectWorker(second);
          const publications = [firstResult.result.publication, secondResult.result.publication].sort();
          expect(publications).toEqual(["lost-race", "published"]);
          const acquisitionResults = [firstResult.result, secondResult.result];
          const successful = acquisitionResults.filter((result) => result.ok);
          expect(successful.length).toBeGreaterThanOrEqual(1);
          for (const result of successful) expect(result.leaseInode).toBe(canonicalInode);
          for (const result of acquisitionResults.filter((candidate) => !candidate.ok)) {
            expect(result.code).toBe("lock_busy");
            expect(result.stage).toBe("lock-acquisition");
            expect(result.boundMs).toBe(2_000);
          }

          const later = await collectWorker(spawnWorker({
            node,
            fixtureRoot,
            home,
            command: "try",
            operationId: `node${node.major}-post-publication`,
          }));
          expect(later.result.ok).toBe(true);
          expect(later.result.leaseInode).toBe(canonicalInode);
          expect((await stat(canonicalLease, { bigint: true })).ino.toString()).toBe(canonicalInode);
          recordedLeasePaths.add(canonicalLease);
        } finally {
          await stopExactTestProcess(first);
          await stopExactTestProcess(second);
        }
      });
    });
  }

  test("delayed post-exit inventory finds no worker, helper, descriptor, or active lease residue", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const pid of recordedPids) expect(await pidAlive(pid)).toBe(false);
    expect(await helperInventory(fixtureRoot)).toEqual([]);
    for (const lease of recordedLeasePaths) {
      expect(await descriptorInventory(lease)).toEqual([]);
    }
    const extractedPackage = join(fixtureRoot, "external", "node_modules", "explodex");
    expect((await readdir(extractedPackage)).includes("dist")).toBe(true);
  });
});
