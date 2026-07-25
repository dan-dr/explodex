import { spawn } from "node:child_process";
import { access, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOperationLock,
  acquireStageLock,
  createNodeLockFileSystem,
  createNodeRuntimeProcess,
  createNodeRuntimeSignals,
  createNodeRuntimeTimers,
  createSystemRuntimeClock,
  releaseOperationLock,
  runBoundedOperation,
  type DirectoryPublishResult,
  type OperationContext,
  type RuntimeAdapters,
} from "explodex/runtime";

type WorkerCommand = "hold" | "try" | "bounded-wait" | "hold-after-spawn" | "race";
type PublicationObservation = DirectoryPublishResult | "existing";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(path: string): Promise<void> {
  while (!await exists(path)) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitForPublicationPeers(directory: string, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = await readdir(directory);
    if (entries.filter((entry) => entry.startsWith("publisher-")).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Publication barrier timed out waiting for ${expected} peers`);
}

async function createAdapters(): Promise<{
  adapters: RuntimeAdapters;
  publication: () => PublicationObservation;
}> {
  const fs = await createNodeLockFileSystem();
  let publication: PublicationObservation = "existing";
  const barrierDirectory = process.env.EXPLODEX_WORKER_PUBLICATION_BARRIER;
  if (barrierDirectory !== undefined) {
    const originalPublish = fs.publishDirectoryExclusive.bind(fs);
    fs.publishDirectoryExclusive = async (
      stagingPath: string,
      finalPath: string,
    ): Promise<DirectoryPublishResult> => {
      const marker = join(barrierDirectory, `publisher-${process.pid}`);
      await writeFile(marker, `${process.pid}\n`, { mode: 0o600 });
      await waitForPublicationPeers(
        barrierDirectory,
        positiveInteger("EXPLODEX_WORKER_PUBLICATION_PEERS", 2),
      );
      publication = await originalPublish(stagingPath, finalPath);
      return publication;
    };
  }
  return {
    adapters: {
      clock: createSystemRuntimeClock(),
      timers: createNodeRuntimeTimers(),
      signals: createNodeRuntimeSignals(),
      process: await createNodeRuntimeProcess(),
      fs,
    },
    publication: () => publication,
  };
}

function noBunOnPath(): boolean {
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  return !paths.some((entry) => entry.toLowerCase().includes("bun"));
}

async function main(): Promise<void> {
  const command = process.argv[2] as WorkerCommand | undefined;
  if (command === undefined) throw new Error("Missing worker command");
  const home = requiredEnv("EXPLODEX_WORKER_HOME");
  const operationId = requiredEnv("EXPLODEX_WORKER_OPERATION_ID");
  const { adapters, publication } = await createAdapters();
  const waitBoundMs = positiveInteger("EXPLODEX_WORKER_WAIT_MS", 250);

  if (command === "bounded-wait") {
    const startedAt = Date.now();
    const result = await runBoundedOperation({
      adapters,
      operation: "packed-lock-wait",
      operationId,
      stageBounds: {
        "lock-acquisition": waitBoundMs,
        "owned-child-shutdown": 1_000,
      },
      run: async (ctx: OperationContext) => {
        const handle = await acquireStageLock(ctx, {
          explodexHome: home,
          resource: "plugins-state",
          pollIntervalMs: 10,
        });
        return {
          descriptor: handle.descriptor,
          leaseDevice: handle.record.leaseDevice,
          leaseInode: handle.record.leaseInode,
        };
      },
    });
    console.log(JSON.stringify({
      ...result,
      pid: process.pid,
      elapsedMs: Date.now() - startedAt,
      bunAbsentFromPath: noBunOnPath(),
      publication: publication(),
    }));
    process.exitCode = result.ok ? 0 : result.error.code === "operation_interrupted" ? 130 : 2;
    return;
  }

  const startedAt = Date.now();
  const acquired = await acquireOperationLock({
    adapters,
    explodexHome: home,
    resource: "plugins-state",
    identity: {
      operationId,
      operation: command,
      startedAt: adapters.clock.nowIso(),
      ownerPid: adapters.process.self().pid,
      ownerProcessStartedAt: adapters.process.self().processStartedAt,
    },
    waitBoundMs: command === "try" ? 0 : waitBoundMs,
    pollIntervalMs: 10,
  });
  const base = {
    pid: process.pid,
    elapsedMs: Date.now() - startedAt,
    bunAbsentFromPath: noBunOnPath(),
    publication: publication(),
  };
  if (!acquired.ok) {
    console.log(JSON.stringify({ ...base, ...acquired }));
    process.exitCode = acquired.code === "lock_interrupted" ? 130 : 2;
    return;
  }

  const acquiredResult = {
    ...base,
    ok: true as const,
    descriptor: acquired.descriptor,
    leasePath: acquired.leasePath,
    leaseDevice: acquired.record.leaseDevice,
    leaseInode: acquired.record.leaseInode,
    closeOnExec: acquired.closeOnExec,
    recoveredStale: acquired.recoveredStale,
    released: false,
  };
  const readyFile = process.env.EXPLODEX_WORKER_READY_FILE;
  if (readyFile !== undefined) {
    await writeFile(readyFile, `${JSON.stringify(acquiredResult)}\n`, { mode: 0o600 });
  }

  if (command === "hold" || command === "race") {
    const releaseFile = process.env.EXPLODEX_WORKER_RELEASE_FILE;
    if (releaseFile === undefined) {
      const keepAlive = setInterval(() => undefined, 60_000);
      await new Promise<void>(() => undefined);
      clearInterval(keepAlive);
    } else {
      await waitForPath(releaseFile);
    }
  } else if (command === "hold-after-spawn") {
    const childLog = requiredEnv("EXPLODEX_WORKER_CHILD_LOG");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    child.unref();
    await writeFile(childLog, `${child.pid ?? 0}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      ...acquiredResult,
      execChildPid: child.pid ?? 0,
      exitingWithoutRelease: true,
    }));
    process.exit(0);
  }

  await releaseOperationLock(adapters, acquired.handle, { timeoutMs: 1_000 });
  console.log(JSON.stringify({
    ...acquiredResult,
    released: true,
    handleState: acquired.handle.state(),
  }));
}

await main();
