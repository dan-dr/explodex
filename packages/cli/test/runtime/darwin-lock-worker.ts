import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { createNodeLockFileSystem } from "../../src/runtime/lock-adapter.ts";
import {
  acquireOperationLock,
  releaseOperationLock,
} from "../../src/runtime/locks.ts";
import {
  createNodeRuntimeSignals,
  createNodeRuntimeTimers,
  createSystemRuntimeClock,
  type ProcessIdentity,
  type RuntimeAdapters,
  type RuntimeProcess,
} from "../../src/runtime/adapters.ts";

type WorkerCommand =
  | "hold"
  | "try"
  | "wait"
  | "hold-until-file"
  | "hold-after-spawn";

type WorkerResult = {
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

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

function processAdapter(): RuntimeProcess {
  const selfIdentity = {
    pid: process.pid,
    processStartedAt: env("EXPLODEX_WORKER_START_IDENTITY"),
  };
  const identify = async (pid: number): Promise<ProcessIdentity | null> => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      const identityPath = process.env.EXPLODEX_WORKER_IDENTITY_DIR === undefined
        ? null
        : `${process.env.EXPLODEX_WORKER_IDENTITY_DIR}/${pid}`;
      if (identityPath === null) return { pid, processStartedAt: `pid-${pid}` };
      const processStartedAt = (await readFile(identityPath, "utf8")).trim();
      return processStartedAt === "" ? null : { pid, processStartedAt };
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "ESRCH" || code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    self: () => ({ ...selfIdentity }),
    identify,
    async isAlive(pid, processStartedAt) {
      return (await identify(pid))?.processStartedAt === processStartedAt;
    },
    async signalExact(identity, signal) {
      const current = await identify(identity.pid);
      if (current?.processStartedAt !== identity.processStartedAt) return false;
      process.kill(identity.pid, signal);
      return true;
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] as WorkerCommand | undefined;
  if (command === undefined) throw new Error("Missing worker command");
  const home = env("EXPLODEX_WORKER_HOME");
  const startIdentity = env("EXPLODEX_WORKER_START_IDENTITY");
  const identityDir = process.env.EXPLODEX_WORKER_IDENTITY_DIR;
  if (identityDir !== undefined) {
    await writeFile(`${identityDir}/${process.pid}`, `${startIdentity}\n`, { mode: 0o600 });
  }
  const adapters: RuntimeAdapters = {
    clock: createSystemRuntimeClock(),
    timers: createNodeRuntimeTimers(),
    signals: createNodeRuntimeSignals(),
    process: processAdapter(),
    fs: await createNodeLockFileSystem(),
  };
  const abort = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
    abort.abort();
  };
  process.once("SIGINT", onInterrupt);
  try {
    const waitBoundMs = command === "wait" ? positiveInteger("EXPLODEX_WORKER_WAIT_MS", 250) : 0;
    const acquired = await acquireOperationLock({
      adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: {
        operationId: env("EXPLODEX_WORKER_OPERATION_ID"),
        operation: command,
        startedAt: adapters.clock.nowIso(),
        ownerPid: process.pid,
        ownerProcessStartedAt: startIdentity,
      },
      waitBoundMs,
      pollIntervalMs: 10,
      abortSignal: abort.signal,
    });
    if (!acquired.ok) {
      const result: WorkerResult = {
        ok: false,
        code: interrupted ? "interrupted" : acquired.code,
        pid: process.pid,
        leasePath: acquired.leasePath,
        interrupted,
      };
      console.log(JSON.stringify(result));
      process.exitCode = interrupted || acquired.code === "lock_interrupted" ? 130 : acquired.code === "lock_busy" ? 2 : 1;
      return;
    }

    const acquiredResult: WorkerResult = {
      ok: true,
      pid: process.pid,
      descriptor: acquired.descriptor,
      leasePath: acquired.leasePath,
      leaseDevice: acquired.record.leaseDevice,
      leaseInode: acquired.record.leaseInode,
      closeOnExec: acquired.closeOnExec,
      recoveredStale: acquired.recoveredStale,
      released: false,
    };
    if (process.env.EXPLODEX_WORKER_READY_FILE !== undefined) {
      await writeFile(process.env.EXPLODEX_WORKER_READY_FILE, `${JSON.stringify(acquiredResult)}\n`, {
        mode: 0o600,
      });
    }

    if (command === "hold") {
      const keepAlive = setInterval(() => {}, 60_000);
      await new Promise<void>(() => undefined);
      clearInterval(keepAlive);
    } else if (command === "hold-until-file") {
      const releaseFile = env("EXPLODEX_WORKER_RELEASE_FILE");
      while (!await exists(releaseFile)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } else if (command === "hold-after-spawn") {
      const { spawn } = await import("node:child_process");
      const childLog = env("EXPLODEX_WORKER_CHILD_LOG");
      const child = spawn(process.execPath, ["-e", `setTimeout(()=>{}, 8000)`], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      child.unref();
      await appendFile(childLog, `${child.pid}\n`);
      process.exit(0);
    }

    await releaseOperationLock(adapters, acquired.handle);
    console.log(JSON.stringify({ ...acquiredResult, released: true } satisfies WorkerResult));
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

await main();
