/**
 * Controlled runtime adapters for bounded-operation and lock fault tests.
 */

import type {
  AdvisoryLease,
  LockFileSystem,
  LockPathKind,
  LockPathStat,
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

type FakeNode = {
  kind: Exclude<LockPathKind, "missing">;
  mode: number;
  uid: number;
  device: string;
  inode: string;
  linkCount: number;
  text: string;
};

type LockFault =
  | "atomic-write"
  | "lease-close"
  | "lease-open"
  | "lease-stat"
  | "path-stat";

export type FakeRuntimeHarness = {
  adapters: RuntimeAdapters;
  advanceMs(ms: number): void;
  emitSignal(signal: SignalName): void;
  setProcessAlive(pid: number, processStartedAt: string, alive: boolean): void;
  setSignalDisposition(
    pid: number,
    processStartedAt: string,
    disposition: "exit" | "remain-alive" | { exitAfterMs: number },
  ): void;
  setSignalBarrier(barrier: (() => void) | null): void;
  setLockFault(fault: LockFault, count?: number): void;
  clearLockFaults(): void;
  replacePath(path: string, node: {
    kind: Exclude<LockPathKind, "missing">;
    mode?: number;
    uid?: number;
    device?: string;
    inode?: string;
    linkCount?: number;
    text?: string;
  }): void;
  setLeaseBusy(path: string, busy: boolean): void;
  signalsSent: Array<{ pid: number; signal: string }>;
  nowMs(): number;
  pendingTimerCount(): number;
  openLockDescriptorCount(): number;
  heldLeaseCount(): number;
  files: Map<string, string>;
  self: ProcessIdentity;
};

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function error(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function createFakeRuntimeHarness(
  options: { startMs?: number; self?: ProcessIdentity } = {},
): FakeRuntimeHarness {
  let now = options.startMs ?? 1_000_000;
  const self: ProcessIdentity = options.self ?? {
    pid: 9001,
    processStartedAt: "2026-07-23T12:00:00.000Z",
  };

  const alive = new Map<string, boolean>();
  const currentStarts = new Map<number, string>();
  const processKey = (pid: number, started: string): string => `${pid}@${started}`;
  alive.set(processKey(self.pid, self.processStartedAt), true);
  currentStarts.set(self.pid, self.processStartedAt);
  const signalDispositions = new Map<
    string,
    "exit" | "remain-alive" | { exitAfterMs: number }
  >();
  let signalBarrier: (() => void) | null = null;

  const signalsSent: Array<{ pid: number; signal: string }> = [];
  const nodes = new Map<string, FakeNode>();
  const files = new Map<string, string>();
  const leaseOwners = new Map<string, number>();
  const externallyBusyLeases = new Set<string>();
  const faults = new Map<LockFault, number>();
  let nextInode = 1000;
  let nextDescriptor = 20;
  let openDescriptors = 0;

  const nextNode = (
    kind: Exclude<LockPathKind, "missing">,
    overrides: Partial<FakeNode> = {},
  ): FakeNode => ({
    kind,
    mode: kind === "directory" ? 0o700 : 0o600,
    uid: 501,
    device: "1",
    inode: String(nextInode++),
    linkCount: 1,
    text: "",
    ...overrides,
  });

  const syncFile = (path: string, node: FakeNode | undefined): void => {
    if (node?.kind === "regular-file") files.set(path, node.text);
    else files.delete(path);
  };

  const setNode = (path: string, node: FakeNode): void => {
    nodes.set(path, node);
    syncFile(path, node);
  };

  const removeNodeTree = (path: string): void => {
    for (const key of [...nodes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        nodes.delete(key);
        files.delete(key);
        leaseOwners.delete(key);
        externallyBusyLeases.delete(key);
      }
    }
  };

  const statRecord = (node: FakeNode | undefined): LockPathStat => node === undefined
    ? { kind: "missing", mode: 0, uid: -1, device: "0", inode: "0", linkCount: 0 }
    : {
        kind: node.kind,
        mode: node.mode,
        uid: node.uid,
        device: node.device,
        inode: node.inode,
        linkCount: node.linkCount,
      };

  const consumeFault = (fault: LockFault): boolean => {
    const remaining = faults.get(fault) ?? 0;
    if (remaining <= 0) return false;
    if (remaining === 1) faults.delete(fault);
    else faults.set(fault, remaining - 1);
    return true;
  };

  let nextTimerId = 1;
  const timers = new Map<number, TimerEntry>();
  const clock: RuntimeClock = {
    nowMs: () => now,
    nowIso: () => new Date(now).toISOString(),
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
      if (set === undefined) {
        set = new Set();
        listeners.set(signal, set);
      }
      set.add(listener);
      return () => set?.delete(listener);
    },
  };

  const processAdapter: RuntimeProcess = {
    self: () => ({ ...self }),
    async identify(pid) {
      const processStartedAt = currentStarts.get(pid);
      if (!processStartedAt || alive.get(processKey(pid, processStartedAt)) !== true) return null;
      return { pid, processStartedAt };
    },
    async isAlive(pid, processStartedAt) {
      return alive.get(processKey(pid, processStartedAt)) === true;
    },
    async signalExact(identity, signal) {
      const barrier = signalBarrier;
      signalBarrier = null;
      barrier?.();
      const current = await processAdapter.identify(identity.pid);
      if (current?.processStartedAt !== identity.processStartedAt) return false;
      signalsSent.push({ pid: identity.pid, signal });
      const disposition = signalDispositions.get(processKey(identity.pid, identity.processStartedAt));
      const exit = (): void => {
        alive.set(processKey(identity.pid, identity.processStartedAt), false);
        currentStarts.delete(identity.pid);
      };
      if (disposition === "exit") exit();
      else if (typeof disposition === "object") {
        runtimeTimers.setTimeout(exit, disposition.exitAfterMs);
      }
      return true;
    },
  };

  const fs: LockFileSystem = {
    async statPath(path) {
      if (consumeFault("path-stat")) throw error("EIO", "Injected path stat failure");
      return statRecord(nodes.get(path));
    },
    async readText(path) {
      const node = nodes.get(path);
      if (node?.kind !== "regular-file") throw error("ENOENT");
      return files.get(path) ?? node.text;
    },
    async mkdir(path, mkdirOptions) {
      if (mkdirOptions?.recursive === false && nodes.has(path)) throw error("EEXIST");
      const segments = path.split("/").filter(Boolean);
      let current = "";
      for (const segment of segments) {
        current += `/${segment}`;
        if (!nodes.has(current)) {
          setNode(current, nextNode("directory", {
            mode: current === path ? mkdirOptions?.mode ?? 0o700 : 0o700,
          }));
        }
      }
    },
    async createDirectoryExclusive(path, mode = 0o700) {
      if (nodes.has(path)) return false;
      if (nodes.get(parentPath(path))?.kind !== "directory") throw error("ENOENT");
      setNode(path, nextNode("directory", { mode }));
      return true;
    },
    async writeFileExclusive(path, data, mode = 0o600) {
      if (nodes.has(path)) return false;
      if (nodes.get(parentPath(path))?.kind !== "directory") throw error("ENOENT");
      setNode(path, nextNode("regular-file", { mode, text: data }));
      return true;
    },
    async writeTextAtomic(path, data, mode = 0o600) {
      if (consumeFault("atomic-write")) throw error("EIO", "Injected atomic write failure");
      if (nodes.get(parentPath(path))?.kind !== "directory") throw error("ENOENT");
      setNode(path, nextNode("regular-file", { mode, text: data }));
    },
    async publishDirectoryExclusive(stagingPath, finalPath) {
      if (nodes.has(finalPath)) return "lost-race";
      const parent = nodes.get(parentPath(finalPath));
      if (parent?.kind !== "directory") throw error("ENOENT");
      const toMove = [...nodes.keys()].filter(
        (key) => key === stagingPath || key.startsWith(`${stagingPath}/`),
      );
      if (toMove.length === 0) throw error("ENOENT");
      for (const key of toMove) {
        const suffix = key.slice(stagingPath.length);
        nodes.set(`${finalPath}${suffix}`, nodes.get(key)!);
        files.set(`${finalPath}${suffix}`, files.get(key) ?? "");
        nodes.delete(key);
        files.delete(key);
      }
      return "published";
    },
    async removePrivateDirectory(path) {
      removeNodeTree(path);
    },
    async tryAcquireLease(path) {
      if (consumeFault("lease-open")) throw error("EIO", "Injected lease open failure");
      const node = nodes.get(path);
      if (node === undefined) throw error("ENOENT");
      if (node.kind !== "regular-file") throw error(node.kind === "symlink" ? "ELOOP" : "EINVAL");
      if (externallyBusyLeases.has(path) || leaseOwners.has(path)) return { status: "busy" };
      const descriptor = nextDescriptor++;
      leaseOwners.set(path, descriptor);
      openDescriptors += 1;
      let closed = false;
      const lease: AdvisoryLease = {
        path,
        descriptor,
        closeOnExec: true,
        async stat() {
          if (closed) throw new Error("closed");
          if (consumeFault("lease-stat")) throw error("EIO", "Injected lease stat failure");
          return statRecord(node);
        },
        async close() {
          if (closed) return;
          if (consumeFault("lease-close")) throw error("EIO", "Injected lease close failure");
          closed = true;
          leaseOwners.delete(path);
          openDescriptors -= 1;
        },
      };
      return { status: "acquired", lease };
    },
    currentUid() {
      return 501;
    },
  };

  const flushDue = (): void => {
    for (;;) {
      const due = [...timers.values()]
        .filter((entry) => !entry.cleared && entry.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
      if (due.length === 0) break;
      for (const entry of due) {
        if (entry.cleared) continue;
        entry.cleared = true;
        timers.delete(entry.id);
        entry.callback();
      }
    }
  };

  return {
    adapters: { clock, timers: runtimeTimers, signals, process: processAdapter, fs },
    advanceMs(ms) {
      now += ms;
      flushDue();
    },
    emitSignal(signal) {
      for (const listener of [...(listeners.get(signal) ?? [])]) listener();
    },
    setProcessAlive(pid, processStartedAt, isAlive) {
      alive.set(processKey(pid, processStartedAt), isAlive);
      if (isAlive) currentStarts.set(pid, processStartedAt);
      else if (currentStarts.get(pid) === processStartedAt) currentStarts.delete(pid);
    },
    setSignalDisposition(pid, processStartedAt, disposition) {
      signalDispositions.set(processKey(pid, processStartedAt), disposition);
    },
    setSignalBarrier(barrier) {
      signalBarrier = barrier;
    },
    setLockFault(fault, count = 1) {
      faults.set(fault, count);
    },
    clearLockFaults() {
      faults.clear();
    },
    replacePath(path, replacement) {
      setNode(path, nextNode(replacement.kind, {
        mode: replacement.mode,
        uid: replacement.uid,
        device: replacement.device,
        inode: replacement.inode,
        linkCount: replacement.linkCount,
        text: replacement.text,
      }));
    },
    setLeaseBusy(path, busy) {
      if (busy) externallyBusyLeases.add(path);
      else externallyBusyLeases.delete(path);
    },
    signalsSent,
    nowMs: () => now,
    pendingTimerCount: () => timers.size,
    openLockDescriptorCount: () => openDescriptors,
    heldLeaseCount: () => leaseOwners.size + externallyBusyLeases.size,
    files,
    self,
  };
}

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
  let caught: unknown;
  void work.then(
    (value) => {
      settled = true;
      result = value;
    },
    (error: unknown) => {
      settled = true;
      caught = error;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  while (!settled && steps < maxSteps) {
    harness.advanceMs(stepMs);
    steps += 1;
    await Promise.resolve();
    await Promise.resolve();
  }
  if (!settled) throw new Error(`runWithClockPump: work did not settle after ${maxSteps} steps`);
  if (caught !== undefined) throw caught;
  return result as T;
}
