/**
 * Controlled runtime adapters for bounded-operation tests.
 * Fake clock, signal bus, process map, and in-memory lock FS.
 */

import type {
  LockFileSystem,
  ProcessIdentity,
  RuntimeAdapters,
  RuntimeClock,
  RuntimeProcess,
  RuntimeSignals,
  RuntimeTimers,
  SignalName,
} from "../../src/runtime/adapters.ts";

type TimerEntry = {
  id: number;
  fireAt: number;
  callback: () => void;
  cleared: boolean;
};

export type FakeRuntimeHarness = {
  adapters: RuntimeAdapters;
  /** Advance fake clock and flush due timers. */
  advanceMs(ms: number): void;
  /** Deliver a cooperative interrupt signal. */
  emitSignal(signal: SignalName): void;
  /** Register a live process identity for isAlive checks. */
  setProcessAlive(pid: number, processStartedAt: string, alive: boolean): void;
  /** Signals delivered via process.signal (never should include protected pids). */
  signalsSent: Array<{ pid: number; signal: string }>;
  /** Current fake time ms. */
  nowMs(): number;
  /** Pending uncleared timer count. */
  pendingTimerCount(): number;
  /** In-memory FS snapshot for lock paths. */
  files: Map<string, string>;
  /** Self identity used for locks. */
  self: ProcessIdentity;
};

export function createFakeRuntimeHarness(
  options: {
    startMs?: number;
    self?: ProcessIdentity;
  } = {},
): FakeRuntimeHarness {
  let now = options.startMs ?? 1_000_000;
  const self: ProcessIdentity = options.self ?? {
    pid: 9001,
    processStartedAt: "2026-07-23T12:00:00.000Z",
  };

  const alive = new Map<string, boolean>();
  const key = (pid: number, started: string) => `${pid}@${started}`;
  alive.set(key(self.pid, self.processStartedAt), true);

  const signalsSent: Array<{ pid: number; signal: string }> = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  let nextTimerId = 1;
  const timers = new Map<number, TimerEntry>();

  const clock: RuntimeClock = {
    nowMs() {
      return now;
    },
    nowIso() {
      return new Date(now).toISOString();
    },
  };

  const runtimeTimers: RuntimeTimers = {
    setTimeout(callback, ms) {
      const id = nextTimerId++;
      const entry: TimerEntry = {
        id,
        fireAt: now + Math.max(0, ms),
        callback,
        cleared: false,
      };
      timers.set(id, entry);
      return {
        clear() {
          entry.cleared = true;
          timers.delete(id);
        },
      };
    },
  };

  const listeners = new Map<SignalName, Set<() => void>>();

  const signals: RuntimeSignals = {
    on(signal, listener) {
      let set = listeners.get(signal);
      if (!set) {
        set = new Set();
        listeners.set(signal, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
  };

  const processAdapter: RuntimeProcess = {
    self() {
      return { ...self };
    },
    async isAlive(pid, processStartedAt) {
      const k = key(pid, processStartedAt);
      if (alive.has(k)) return alive.get(k) === true;
      // Unknown pid: dead by default in fixtures.
      return false;
    },
    async signal(pid, signal) {
      signalsSent.push({ pid, signal });
    },
  };

  const fs: LockFileSystem = {
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    async readText(path) {
      const v = files.get(path);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    async writeFileExclusive(path, data) {
      if (files.has(path)) return false;
      files.set(path, data);
      return true;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async mkdir(path) {
      dirs.add(path);
      // also parent segments lightly
      dirs.add(path);
    },
    async removeFile(path) {
      files.delete(path);
    },
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.delete(from);
      files.set(to, v);
    },
  };

  function flushDue(): void {
    // Fire all timers whose fireAt <= now, in order; allow cascading.
    for (;;) {
      const due = [...timers.values()]
        .filter((t) => !t.cleared && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
      if (due.length === 0) break;
      for (const t of due) {
        if (t.cleared) continue;
        t.cleared = true;
        timers.delete(t.id);
        t.callback();
      }
    }
  }

  const harness: FakeRuntimeHarness = {
    adapters: {
      clock,
      timers: runtimeTimers,
      signals,
      process: processAdapter,
      fs,
    },
    advanceMs(ms) {
      now += ms;
      flushDue();
    },
    emitSignal(signal) {
      const set = listeners.get(signal);
      if (!set) return;
      for (const listener of [...set]) listener();
    },
    setProcessAlive(pid, processStartedAt, isAlive) {
      alive.set(key(pid, processStartedAt), isAlive);
    },
    signalsSent,
    nowMs() {
      return now;
    },
    pendingTimerCount() {
      return timers.size;
    },
    files,
    self,
  };

  return harness;
}

/** Helper: run a promise while pumping the fake clock in small steps. */
export async function runWithClockPump<T>(
  harness: FakeRuntimeHarness,
  work: Promise<T>,
  options: { stepMs?: number; maxSteps?: number } = {},
): Promise<T> {
  const stepMs = options.stepMs ?? 10;
  const maxSteps = options.maxSteps ?? 10_000;
  let steps = 0;
  let settled = false;
  let result: T | undefined;
  let error: unknown;

  void work.then(
    (value) => {
      settled = true;
      result = value;
    },
    (err: unknown) => {
      settled = true;
      error = err;
    },
  );

  // Allow microtasks to schedule timers first.
  await Promise.resolve();
  await Promise.resolve();

  while (!settled && steps < maxSteps) {
    harness.advanceMs(stepMs);
    steps += 1;
    await Promise.resolve();
    await Promise.resolve();
  }

  if (!settled) {
    throw new Error(`runWithClockPump: work did not settle after ${maxSteps} steps`);
  }
  if (error !== undefined) throw error;
  return result as T;
}
