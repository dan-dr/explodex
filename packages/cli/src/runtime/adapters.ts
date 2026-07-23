/**
 * Injectable adapters for the bounded-operation runtime.
 * Production uses Node timers/signals/process; tests supply controlled fixtures.
 */

export type RuntimeClock = {
  /** Monotonic-ish milliseconds for deadline math (Date.now is acceptable). */
  nowMs(): number;
  nowIso(): string;
};

export type RuntimeTimerHandle = {
  clear(): void;
};

export type RuntimeTimers = {
  /**
   * Schedule a one-shot callback after `ms` milliseconds.
   * Tests may advance a fake clock and flush pending timers.
   */
  setTimeout(callback: () => void, ms: number): RuntimeTimerHandle;
};

export type SignalName = "SIGINT" | "SIGTERM";

export type RuntimeSignals = {
  /**
   * Register a listener for cooperative interruption.
   * Returns an unsubscribe function.
   */
  on(signal: SignalName, listener: () => void): () => void;
};

export type ProcessIdentity = {
  pid: number;
  processStartedAt: string;
};

export type RuntimeProcess = {
  /** Current CLI process identity (for lock ownership). */
  self(): ProcessIdentity;
  /**
   * True when the recorded pid is still alive AND still matches start identity.
   * Tests control this map; production may use kill(pid, 0) + start-time lookup.
   */
  isAlive(pid: number, processStartedAt: string): Promise<boolean>;
  /**
   * Send a signal to an exact PID. Runtime only calls this for command-owned children.
   * Must never be used against protected ChatGPT or foreign processes.
   */
  signal(pid: number, signal: "SIGTERM" | "SIGINT"): Promise<void>;
};

export type LockFileSystem = {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  /**
   * Atomic exclusive create. Returns false when the path already exists.
   * Production should use O_EXCL / wx flag.
   */
  writeFileExclusive(path: string, data: string, mode?: number): Promise<boolean>;
  writeFile(path: string, data: string, mode?: number): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  removeFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
};

export type RuntimeAdapters = {
  clock: RuntimeClock;
  timers: RuntimeTimers;
  signals: RuntimeSignals;
  process: RuntimeProcess;
  fs: LockFileSystem;
};

export function createSystemRuntimeClock(): RuntimeClock {
  return {
    nowMs() {
      return Date.now();
    },
    nowIso() {
      return new Date().toISOString();
    },
  };
}

export function createNodeRuntimeTimers(): RuntimeTimers {
  return {
    setTimeout(callback, ms) {
      const handle = globalThis.setTimeout(callback, ms);
      return {
        clear() {
          globalThis.clearTimeout(handle);
        },
      };
    },
  };
}

export function createNodeRuntimeSignals(): RuntimeSignals {
  return {
    on(signal, listener) {
      const handler = (): void => {
        listener();
      };
      process.on(signal, handler);
      return () => {
        process.off(signal, handler);
      };
    },
  };
}

export async function createNodeRuntimeProcess(): Promise<RuntimeProcess> {
  const startedAt = new Date().toISOString();
  return {
    self() {
      return { pid: process.pid, processStartedAt: startedAt };
    },
    async isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        // Process may already be gone.
      }
    },
  };
}

export async function createNodeLockFileSystem(): Promise<LockFileSystem> {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");

  return {
    async exists(path) {
      try {
        await fs.access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readText(path) {
      return fs.readFile(path, "utf8");
    },
    async writeFileExclusive(path, data, mode = 0o600) {
      try {
        await fs.writeFile(path, data, { encoding: "utf8", flag: "wx", mode });
        return true;
      } catch (error: unknown) {
        const err = error as { code?: string };
        if (err.code === "EEXIST") return false;
        throw error;
      }
    },
    async writeFile(path, data, mode = 0o600) {
      await fs.writeFile(path, data, { encoding: "utf8", mode });
    },
    async mkdir(path, options) {
      await fs.mkdir(path, {
        recursive: options?.recursive ?? true,
        mode: options?.mode ?? 0o700,
      });
    },
    async removeFile(path) {
      try {
        await fs.unlink(path);
      } catch (error: unknown) {
        const err = error as { code?: string };
        if (err.code !== "ENOENT") throw error;
      }
    },
    async rename(from, to) {
      await fs.rename(from, to);
    },
  };
}

export async function createDefaultRuntimeAdapters(): Promise<RuntimeAdapters> {
  const [processAdapter, fs] = await Promise.all([
    createNodeRuntimeProcess(),
    createNodeLockFileSystem(),
  ]);
  return {
    clock: createSystemRuntimeClock(),
    timers: createNodeRuntimeTimers(),
    signals: createNodeRuntimeSignals(),
    process: processAdapter,
    fs,
  };
}
