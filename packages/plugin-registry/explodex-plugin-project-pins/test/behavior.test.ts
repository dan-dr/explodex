import { describe, expect, test } from "bun:test";
import {
  GLOBAL_STATE_KEYS,
  LEGACY_PROJECT_PINS_KEY,
  PROJECT_PINS_KEY,
  setupProjectPins,
} from "../src/index.ts";

const ALPHA = "11111111-1111-4111-8111-111111111111";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class FakeStyleElement {
  id = "";
  textContent = "";
  removed = false;

  remove(): void {
    this.removed = true;
  }
}

function createHarness(
  options: {
    deferProjectPins?: boolean;
    legacyPins?: Record<string, string>;
    projectOrders?: unknown;
  } = {},
) {
  const persisted = new Map<string, unknown>([
    [
      LEGACY_PROJECT_PINS_KEY,
      options.legacyPins ?? { [ALPHA]: "project-a" },
    ],
  ]);
  const globalState = new Map<string, unknown>([
    [GLOBAL_STATE_KEYS.projectOrders, options.projectOrders ?? {}],
  ]);
  const writes: Array<{ key: string; value: unknown }> = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const styles = new Map<string, FakeStyleElement>();
  const pendingProjectPins = deferred<unknown>();
  let stopZoneCalls = 0;
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();

  const document = {
    body: {
      appendChild() {},
    },
    head: {
      appendChild(element: FakeStyleElement) {
        styles.set(element.id, element);
      },
    },
    createElement(tag: string) {
      if (tag === "style") return new FakeStyleElement();
      return {
        addEventListener() {},
        appendChild() {},
        setAttribute() {},
        style: {},
      };
    },
    createElementNS() {
      return {
        appendChild() {},
        classList: { add() {} },
        setAttribute() {},
        style: {},
      };
    },
    getElementById(id: string) {
      const style = styles.get(id);
      return style?.removed ? null : style ?? null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  const runtime = {
    document,
    location: { pathname: "/" },
    innerHeight: 800,
    innerWidth: 1_200,
    addEventListener(type: string, listener: (event: unknown) => void) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    requestAnimationFrame(callback: () => void) {
      callback();
      return 1;
    },
    setTimeout(callback: () => void) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    PointerEvent: class {},
  };

  const api = {
    bridge: {
      isAvailable: () => true,
      async rpc(method: string) {
        if (method === "list-pinned-threads") return { threadIds: [] };
        return null;
      },
    },
    components: {
      statusToast() {},
    },
    inject: {
      observeZone() {
        return () => {
          stopZoneCalls += 1;
        };
      },
    },
    log: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
    async migrate(migrations: any[]) {
      for (const migration of migrations) {
        await migration.run({
          renameKey(oldKey: string, newKey: string) {
            if (!persisted.has(oldKey)) return false;
            if (!persisted.has(newKey)) {
              persisted.set(newKey, persisted.get(oldKey));
            }
            persisted.delete(oldKey);
            return true;
          },
        });
      }
    },
    storage: {
      persisted: {
        get(key: string, fallback: unknown) {
          return persisted.has(key) ? persisted.get(key) : fallback;
        },
        remove(key: string) {
          persisted.delete(key);
        },
        set(key: string, value: unknown) {
          persisted.set(key, value);
        },
      },
      globalState: {
        async get(key: string) {
          if (
            options.deferProjectPins &&
            key === GLOBAL_STATE_KEYS.projectPins
          ) {
            return pendingProjectPins.promise;
          }
          return globalState.get(key);
        },
        async set(key: string, value: unknown) {
          writes.push({ key, value });
          globalState.set(key, value);
        },
      },
    },
  };

  return {
    api,
    globalState,
    listeners,
    pendingProjectPins,
    persisted,
    runtime,
    styles,
    timers,
    writes,
    get stopZoneCalls() {
      return stopZoneCalls;
    },
  };
}

describe("VAL-PLUG-011 Project Pins persistence and teardown", () => {
  test("migrates persisted pins into shared state and disposes listeners, zone work, timers, and styles once", async () => {
    const harness = createHarness();
    const teardown = await setupProjectPins(
      harness.api as any,
      harness.runtime as any,
    );
    await settle();

    expect(harness.persisted.has(LEGACY_PROJECT_PINS_KEY)).toBe(false);
    expect(harness.persisted.has(PROJECT_PINS_KEY)).toBe(false);
    expect(harness.globalState.get(GLOBAL_STATE_KEYS.projectPins)).toEqual({
      [ALPHA]: "project-a",
    });
    expect(
      ["pointerdown", "click", "keydown"].map(
        (type) => harness.listeners.get(type)?.size ?? 0,
      ),
    ).toEqual([1, 1, 1]);
    expect(harness.styles.get("explodex-pin-scope-styles")?.removed).toBe(
      false,
    );

    await teardown?.();
    await teardown?.();

    expect(
      [...harness.listeners.values()].every(
        (registered) => registered.size === 0,
      ),
    ).toBe(true);
    expect(harness.stopZoneCalls).toBe(1);
    expect(harness.timers.size).toBe(0);
    expect(harness.styles.get("explodex-pin-scope-styles")?.removed).toBe(
      true,
    );
  });

  test("prevents late shared-state hydration from writing or remounting after unload", async () => {
    const harness = createHarness({ deferProjectPins: true });
    const teardown = await setupProjectPins(
      harness.api as any,
      harness.runtime as any,
    );
    await teardown?.();
    harness.pendingProjectPins.resolve({});
    await settle();

    expect(harness.writes).toEqual([]);
    expect(harness.persisted.get(PROJECT_PINS_KEY)).toEqual({
      [ALPHA]: "project-a",
    });
    expect(harness.styles.size).toBe(0);
    expect(harness.stopZoneCalls).toBe(1);
  });

  test("restores host recency ordering when no project pins remain", async () => {
    const harness = createHarness({
      legacyPins: {},
      projectOrders: {
        "project-a": {
          threadIds: [`local:${ALPHA}`],
        },
      },
    });
    const teardown = await setupProjectPins(
      harness.api as any,
      harness.runtime as any,
    );
    await settle();

    expect(harness.globalState.get(GLOBAL_STATE_KEYS.projectOrders)).toEqual({
      "project-a": { sortKey: "updated_at" },
    });
    expect(harness.writes).toContainEqual({
      key: GLOBAL_STATE_KEYS.projectOrders,
      value: {
        "project-a": { sortKey: "updated_at" },
      },
    });

    await teardown?.();
  });
});
