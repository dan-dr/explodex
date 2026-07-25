/**
 * Real Darwin cross-process advisory-lease integration (VAL-HOST-027/028/029).
 * Drives packages/cli/test/runtime/darwin-lock-worker.ts under packed Node 22
 * and Node 24 to prove kernel contention, holder-death release, FD_CLOEXEC
 * non-inheritance, SIGINT/timeout at lock boundaries, and no residue.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const WORKER = join(import.meta.dir, "darwin-lock-worker.ts");

function findNodeVersion(version: string): string | null {
  const candidate = join(homedir(), ".local", "share", "mise", "installs", "node", version, "bin", "node");
  return existsSync(candidate) ? candidate : null;
}

const NODE_22 = findNodeVersion("22.21.0");
const NODE_24 = findNodeVersion("24.16.0");

type WorkerOpts = {
  nodeBin: string;
  home: string;
  identityDir: string;
  command: string;
  startIdentity: string;
  operationId: string;
  readyFile?: string;
  releaseFile?: string;
  childLog?: string;
  waitMs?: number;
};

function spawnWorker(opts: WorkerOpts): ChildProcess {
  const env: Record<string, string> = {
    ...process.env,
    EXPLODEX_WORKER_HOME: opts.home,
    EXPLODEX_WORKER_START_IDENTITY: opts.startIdentity,
    EXPLODEX_WORKER_IDENTITY_DIR: opts.identityDir,
    EXPLODEX_WORKER_OPERATION_ID: opts.operationId,
  };
  if (opts.readyFile !== undefined) env.EXPLODEX_WORKER_READY_FILE = opts.readyFile;
  if (opts.releaseFile !== undefined) env.EXPLODEX_WORKER_RELEASE_FILE = opts.releaseFile;
  if (opts.childLog !== undefined) env.EXPLODEX_WORKER_CHILD_LOG = opts.childLog;
  if (opts.waitMs !== undefined) env.EXPLODEX_WORKER_WAIT_MS = String(opts.waitMs);
  return spawn(opts.nodeBin, [WORKER, opts.command], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`Timeout waiting for file: ${path}`);
}

async function collectResult(
  child: ChildProcess,
  timeoutMs = 8_000,
): Promise<{ stdout: string; exitCode: number | null }> {
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker timed out")), timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { stdout, exitCode };
}

function killChild(child: ChildProcess): void {
  if (!child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already exited.
  }
}

type ParsedWorkerResult = {
  ok: boolean;
  code?: string;
  pid: number;
  descriptor?: number;
  leasePath?: string;
  leaseDevice?: string;
  leaseInode?: string;
  closeOnExec?: boolean;
  recoveredStale?: boolean;
  released?: boolean;
  interrupted?: boolean;
};

function parseResult(stdout: string): ParsedWorkerResult {
  return JSON.parse(stdout.trim()) as ParsedWorkerResult;
}

const nodeConfigs: Array<{ label: string; bin: string | null }> = [
  { label: "Node 22", bin: NODE_22 },
  { label: "Node 24", bin: NODE_24 },
];

for (const { label, bin } of nodeConfigs) {
  const describeFn = bin !== null ? describe : describe.skip;

  describeFn(`Darwin lock integration — ${label} (VAL-HOST-027/028/029)`, () => {
    let tmpRoot: string;
    let home: string;
    let identityDir: string;
    const nodeBin = bin ?? "node";

    beforeAll(async () => {
      tmpRoot = await mkdtemp(join(tmpdir(), "explodex-lock-int-"));
      home = join(tmpRoot, "home");
      identityDir = join(tmpRoot, "identity");
      await mkdir(home, { recursive: true });
      await mkdir(identityDir, { recursive: true });
    });

    afterAll(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    test("real kernel contention: contender gets lock_busy while holder holds", async () => {
      const readyFile = join(tmpRoot, "ready-contention.json");
      const holder = spawnWorker({
        nodeBin,
        home,
        identityDir,
        command: "hold",
        startIdentity: "holder-contention",
        operationId: "op-contention-holder",
        readyFile,
      });
      try {
        await waitForFile(readyFile);
        const { stdout, exitCode } = await collectResult(
          spawnWorker({
            nodeBin,
            home,
            identityDir,
            command: "try",
            startIdentity: "contender-contention",
            operationId: "op-contention-contender",
          }),
        );
        const result = parseResult(stdout);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("lock_busy");
        expect(exitCode).toBe(2);
      } finally {
        killChild(holder);
        await waitPidExit(holder.pid ?? 0);
      }
    });

    test("holder-death release: contender acquires after holder process exits", async () => {
      const readyFile = join(tmpRoot, "ready-death.json");
      const holder = spawnWorker({
        nodeBin,
        home,
        identityDir,
        command: "hold",
        startIdentity: "holder-death",
        operationId: "op-death-holder",
        readyFile,
      });
      try {
        await waitForFile(readyFile);
        killChild(holder);
        await waitPidExit(holder.pid ?? 0);
        await new Promise((r) => setTimeout(r, 200));
        const { stdout, exitCode } = await collectResult(
          spawnWorker({
            nodeBin,
            home,
            identityDir,
            command: "try",
            startIdentity: "contender-death",
            operationId: "op-death-contender",
          }),
        );
        const result = parseResult(stdout);
        expect(result.ok).toBe(true);
        expect(result.recoveredStale).toBe(true);
        expect(exitCode).toBe(0);
      } finally {
        killChild(holder);
      }
    });

    test("FD_CLOEXEC: spawned child does not inherit the parent-held lease", async () => {
      const readyFile = join(tmpRoot, "ready-cloexec.json");
      const childLog = join(tmpRoot, "child-pids-cloexec.log");
      const holder = spawnWorker({
        nodeBin,
        home,
        identityDir,
        command: "hold-after-spawn",
        startIdentity: "holder-cloexec",
        operationId: "op-cloexec-holder",
        readyFile,
        childLog,
      });
      let childPid = 0;
      try {
        const { exitCode } = await collectResult(holder, 5_000);
        expect(exitCode).toBe(0);
        const childPidStr = await readFile(childLog, "utf8");
        childPid = parseInt(childPidStr.trim(), 10);
        expect(childPid).toBeGreaterThan(0);
        expect(await pidAlive(childPid)).toBe(true);
        const { stdout, exitCode: contenderExit } = await collectResult(
          spawnWorker({
            nodeBin,
            home,
            identityDir,
            command: "try",
            startIdentity: "contender-cloexec",
            operationId: "op-cloexec-contender",
          }),
        );
        const result = parseResult(stdout);
        expect(result.ok).toBe(true);
        expect(contenderExit).toBe(0);
      } finally {
        killChild(holder);
        if (childPid > 0) {
          await killPid(childPid);
          await waitPidExit(childPid, 3_000);
        }
      }
    });

    test("SIGINT at lock boundary yields interrupted outcome and exit code 130", async () => {
      const readyFile = join(tmpRoot, "ready-sigint.json");
      const holder = spawnWorker({
        nodeBin,
        home,
        identityDir,
        command: "hold",
        startIdentity: "holder-sigint",
        operationId: "op-sigint-holder",
        readyFile,
      });
      try {
        await waitForFile(readyFile);
        const contender = spawnWorker({
          nodeBin,
          home,
          identityDir,
          command: "wait",
          startIdentity: "contender-sigint",
          operationId: "op-sigint-contender",
          waitMs: 5_000,
        });
        await new Promise((r) => setTimeout(r, 200));
        contender.kill("SIGINT");
        const { stdout, exitCode } = await collectResult(contender, 5_000);
        const result = parseResult(stdout);
        expect(result.ok).toBe(false);
        expect(result.interrupted).toBe(true);
        expect(exitCode).toBe(130);
      } finally {
        killChild(holder);
        await waitPidExit(holder.pid ?? 0);
      }
    });

    test("timeout at lock boundary yields lock_busy after declared bound", async () => {
      const readyFile = join(tmpRoot, "ready-timeout.json");
      const holder = spawnWorker({
        nodeBin,
        home,
        identityDir,
        command: "hold",
        startIdentity: "holder-timeout",
        operationId: "op-timeout-holder",
        readyFile,
      });
      try {
        await waitForFile(readyFile);
        const { stdout, exitCode } = await collectResult(
          spawnWorker({
            nodeBin,
            home,
            identityDir,
            command: "wait",
            startIdentity: "contender-timeout",
            operationId: "op-timeout-contender",
            waitMs: 200,
          }),
          5_000,
        );
        const result = parseResult(stdout);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("lock_busy");
        expect(exitCode).toBe(2);
      } finally {
        killChild(holder);
        await waitPidExit(holder.pid ?? 0);
      }
    });

    test("repetition: multiple acquire/release cycles do not accumulate residue", async () => {
      for (let i = 0; i < 3; i++) {
        const { stdout, exitCode } = await collectResult(
          spawnWorker({
            nodeBin,
            home,
            identityDir,
            command: "try",
            startIdentity: `rep-${i}`,
            operationId: `op-rep-${i}`,
          }),
        );
        const result = parseResult(stdout);
        expect(result.ok).toBe(true);
        expect(result.released).toBe(true);
        expect(exitCode).toBe(0);
      }
    });

    test("no residue: no leftover held lease or process after all operations", async () => {
      const { stdout, exitCode } = await collectResult(
        spawnWorker({
          nodeBin,
          home,
          identityDir,
          command: "try",
          startIdentity: "cleanup-check",
          operationId: "op-cleanup",
        }),
      );
      const result = parseResult(stdout);
      expect(result.ok).toBe(true);
      expect(result.released).toBe(true);
      expect(exitCode).toBe(0);
      const lockDir = join(home, "locks", "plugins-state.lock");
      const lockStat = await access(lockDir).then(
        () => "exists",
        () => "missing",
      );
      expect(lockStat).toBe("exists");
    });
  });
}
