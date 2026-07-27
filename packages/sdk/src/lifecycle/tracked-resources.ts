/**
 * Runtime-tracked resource registry for a single plugin generation.
 * Disposes mounts, listeners, observers, timers, and subscriptions on teardown.
 * Does not claim universal detection of arbitrary untracked third-party effects.
 */

export type TrackedResourceKind =
  | "mount"
  | "listener"
  | "timeout"
  | "interval"
  | "observer"
  | "subscription"
  | "asset";

export type TrackedResourceSnapshot = {
  readonly mounts: number;
  readonly listeners: number;
  readonly timeouts: number;
  readonly intervals: number;
  readonly observers: number;
  readonly subscriptions: number;
  readonly assets: number;
  readonly total: number;
};

export type TrackedDisposalFailure = {
  readonly kind: TrackedResourceKind;
  readonly message: string;
};

export type TrackedDisposalResult = {
  readonly attempted: TrackedResourceSnapshot;
  readonly disposed: TrackedResourceSnapshot;
  readonly failed: TrackedResourceSnapshot;
  readonly residual: TrackedResourceSnapshot;
  readonly failures: readonly TrackedDisposalFailure[];
};

type Disposable = {
  dispose(): void;
};

type MountLike = {
  remove?(): void;
  parentNode?: { removeChild(child: unknown): void } | null;
};

type TrackedEventListener = ((event: unknown) => void) | { handleEvent(event: unknown): void };

type EventTargetLike = {
  addEventListener(
    type: string,
    listener: TrackedEventListener | null,
    options?: boolean | Record<string, unknown>,
  ): void;
  removeEventListener(
    type: string,
    listener: TrackedEventListener | null,
    options?: boolean | Record<string, unknown>,
  ): void;
};

type ObserverLike = {
  disconnect(): void;
};

export type TrackedResourceRegistry = {
  readonly generation: number;
  readonly token: string;
  readonly accepting: boolean;
  snapshot(): TrackedResourceSnapshot;
  rejectNew(reason: string): void;
  disposeAll(): TrackedDisposalResult;
  track: {
    mount(node: MountLike): void;
    listen(
      target: EventTargetLike,
      type: string,
      listener: TrackedEventListener | null,
      options?: boolean | Record<string, unknown>,
    ): void;
    timeout(handler: (...args: unknown[]) => void, ms: number, ...args: unknown[]): number;
    interval(handler: (...args: unknown[]) => void, ms: number, ...args: unknown[]): number;
    observe(observer: ObserverLike): void;
    subscription(unsubscribe: () => void): void;
    asset(handle: { revoke(): void }): void;
  };
};

function emptySnapshot(): TrackedResourceSnapshot {
  return {
    mounts: 0,
    listeners: 0,
    timeouts: 0,
    intervals: 0,
    observers: 0,
    subscriptions: 0,
    assets: 0,
    total: 0,
  };
}

export function createTrackedResourceRegistry(options: {
  generation: number;
  token: string;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
}): TrackedResourceRegistry {
  const timers = options.timers ?? {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };

  let accepting = true;
  const entries: Array<{ kind: TrackedResourceKind; dispose: () => void }> = [];
  let disposalResult: TrackedDisposalResult | null = null;

  function assertAccepting(kind: TrackedResourceKind): void {
    if (!accepting) {
      throw new Error(
        `Tracked resource registration rejected for ${kind}: generation ${options.generation} is no longer accepting resources`,
      );
    }
  }

  function add(kind: TrackedResourceKind, dispose: () => void): void {
    assertAccepting(kind);
    entries.push({ kind, dispose });
  }

  function snapshotEntries(
    tracked: ReadonlyArray<{ kind: TrackedResourceKind }>,
  ): TrackedResourceSnapshot {
    const counts = emptySnapshot();
    const mutable = counts as {
      -readonly [K in keyof TrackedResourceSnapshot]: TrackedResourceSnapshot[K];
    };
    for (const entry of tracked) {
      switch (entry.kind) {
        case "mount":
          mutable.mounts += 1;
          break;
        case "listener":
          mutable.listeners += 1;
          break;
        case "timeout":
          mutable.timeouts += 1;
          break;
        case "interval":
          mutable.intervals += 1;
          break;
        case "observer":
          mutable.observers += 1;
          break;
        case "subscription":
          mutable.subscriptions += 1;
          break;
        case "asset":
          mutable.assets += 1;
          break;
        default: {
          const _exhaustive: never = entry.kind;
          void _exhaustive;
        }
      }
      mutable.total += 1;
    }
    return counts;
  }

  function snapshot(): TrackedResourceSnapshot {
    return snapshotEntries(entries);
  }

  function disposeAll(): TrackedDisposalResult {
    accepting = false;
    if (disposalResult !== null) return disposalResult;

    const attemptedEntries = [...entries];
    const disposedEntries: Array<{ kind: TrackedResourceKind }> = [];
    const failedEntries: Array<{ kind: TrackedResourceKind; dispose: () => void }> = [];
    const failures: TrackedDisposalFailure[] = [];
    // Dispose in reverse registration order.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      try {
        entry.dispose();
        disposedEntries.push(entry);
      } catch (error: unknown) {
        failedEntries.unshift(entry);
        failures.push({
          kind: entry.kind,
          message: error instanceof Error ? error.message : "Tracked resource disposal failed",
        });
      }
    }
    entries.splice(0, entries.length, ...failedEntries);
    disposalResult = {
      attempted: snapshotEntries(attemptedEntries),
      disposed: snapshotEntries(disposedEntries),
      failed: snapshotEntries(failedEntries),
      residual: snapshot(),
      failures,
    };
    return disposalResult;
  }

  const track: TrackedResourceRegistry["track"] = {
    mount(node) {
      add("mount", () => {
        if (typeof node.remove === "function") {
          node.remove();
          return;
        }
        const parent = node.parentNode;
        if (parent && typeof parent.removeChild === "function") {
          parent.removeChild(node);
        }
      });
    },
    listen(target, type, listener, listenerOptions) {
      assertAccepting("listener");
      target.addEventListener(type, listener, listenerOptions);
      entries.push({ kind: "listener", dispose: () => {
        target.removeEventListener(type, listener, listenerOptions);
      } });
    },
    timeout(handler, ms, ...args) {
      assertAccepting("timeout");
      const id = timers.setTimeout(handler, ms, ...args) as unknown as number;
      entries.push({ kind: "timeout", dispose: () => {
        timers.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      } });
      return id;
    },
    interval(handler, ms, ...args) {
      assertAccepting("interval");
      const id = timers.setInterval(handler, ms, ...args) as unknown as number;
      entries.push({ kind: "interval", dispose: () => {
        timers.clearInterval(id as unknown as ReturnType<typeof setInterval>);
      } });
      return id;
    },
    observe(observer) {
      add("observer", () => {
        observer.disconnect();
      });
    },
    subscription(unsubscribe) {
      add("subscription", () => {
        unsubscribe();
      });
    },
    asset(handle) {
      add("asset", () => {
        handle.revoke();
      });
    },
  };

  return {
    generation: options.generation,
    token: options.token,
    get accepting() {
      return accepting;
    },
    snapshot,
    rejectNew(_reason: string) {
      accepting = false;
    },
    disposeAll,
    track,
  };
}

/** Sum two snapshots (for harness aggregation). */
export function sumSnapshots(
  left: TrackedResourceSnapshot,
  right: TrackedResourceSnapshot,
): TrackedResourceSnapshot {
  return {
    mounts: left.mounts + right.mounts,
    listeners: left.listeners + right.listeners,
    timeouts: left.timeouts + right.timeouts,
    intervals: left.intervals + right.intervals,
    observers: left.observers + right.observers,
    subscriptions: left.subscriptions + right.subscriptions,
    assets: left.assets + right.assets,
    total: left.total + right.total,
  };
}

export type { Disposable };
