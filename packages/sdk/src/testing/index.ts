/**
 * Explicit testing harness surface for inert registration and lifecycle.
 * Not a general renderer activation API.
 */

import { createContext, runInContext } from "node:vm";

export {
  DEFAULT_SETUP_TIMEOUT_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  PRIVATE_PHASE_GLOBAL,
  PRIVATE_REGISTER_GLOBAL,
  createPrivateRegistrationController,
  createPluginLifecycleHost,
  createTrackedResourceRegistry,
  registerPluginDefinition,
  sumSnapshots,
  type ApplyPluginResult,
  type PluginApplicationRecord,
  type PluginApplicationStatus,
  type PluginLifecycleHost,
  type PrivateRegistrationController,
  type RegistrationHost,
  type RegistrationPhaseResult,
  type RegistrationRecord,
  type SideEffectKind,
  type SideEffectObservations,
  type SupersededCleanupFailure,
  type TrackedDisposalFailure,
  type TrackedDisposalResult,
  type TrackedResourceKind,
  type TrackedResourceRegistry,
  type TrackedResourceSnapshot,
  type UnloadPluginResult,
} from "../lifecycle/index.ts";

import {
  createPluginLifecycleHost,
  createPrivateRegistrationController,
  PRIVATE_PHASE_GLOBAL,
  PRIVATE_REGISTER_GLOBAL,
  type PluginLifecycleHost,
  type PrivateRegistrationController,
  type RegistrationHost,
  type RegistrationPhaseResult,
  type SideEffectKind,
  type TrackedResourceSnapshot,
} from "../lifecycle/index.ts";
import type { PluginDefinition } from "../types/plugin.ts";

export type InertRegistrationHarness = {
  readonly controller: PrivateRegistrationController;
  readonly host: RegistrationHost;
  /**
   * Evaluate classic-script source in a Function realm bound to `host`,
   * collecting exactly one inert registration for `expectedPluginId`.
   */
  evaluateSource(options: {
    expectedPluginId: string;
    source: string;
  }): Promise<RegistrationPhaseResult>;
  /** Evaluate a caller-provided function inside the private phase. */
  evaluate(options: {
    expectedPluginId: string;
    evaluate: () => void;
  }): RegistrationPhaseResult;
};

const INTERNAL_GLOBAL_WRITES = new Set([
  "__ExplodexPluginBundle",
  PRIVATE_PHASE_GLOBAL,
  PRIVATE_REGISTER_GLOBAL,
]);

function createObservedInertRealm(
  host: RegistrationHost,
  recordSideEffect: (kind: SideEffectKind) => void,
): object {
  let recording = false;
  let nextTimerId = 1;

  const recordDom = (): void => recordSideEffect("domMutations");
  const inertNode = (): Record<string, unknown> => {
    const node = {
      append: recordDom,
      appendChild(child: unknown) {
        recordDom();
        return child;
      },
      prepend: recordDom,
      remove: recordDom,
      removeAttribute: recordDom,
      removeChild(child: unknown) {
        recordDom();
        return child;
      },
      replaceChildren: recordDom,
      setAttribute: recordDom,
      addEventListener: recordDom,
      removeEventListener: recordDom,
      style: new Proxy(Object.create(null) as Record<string, unknown>, {
        set(target, property, value) {
          recordDom();
          return Reflect.set(target, property, value);
        },
        defineProperty(target, property, descriptor) {
          recordDom();
          return Reflect.defineProperty(target, property, descriptor);
        },
        deleteProperty(target, property) {
          recordDom();
          return Reflect.deleteProperty(target, property);
        },
      }),
    };
    return new Proxy(node as Record<string, unknown>, {
      set(target, property, value) {
        recordDom();
        return Reflect.set(target, property, value);
      },
      defineProperty(target, property, descriptor) {
        recordDom();
        return Reflect.defineProperty(target, property, descriptor);
      },
      deleteProperty(target, property) {
        recordDom();
        return Reflect.deleteProperty(target, property);
      },
    });
  };
  const body = inertNode();
  const documentTarget = {
    body,
    head: inertNode(),
    documentElement: inertNode(),
    createElement: inertNode,
    createTextNode(text: string) {
      const node = inertNode();
      Reflect.set(node, "textContent", text);
      return node;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener: recordDom,
    removeEventListener: recordDom,
  };
  const document = new Proxy(documentTarget as Record<string, unknown>, {
    set(target, property, value) {
      recordDom();
      return Reflect.set(target, property, value);
    },
    defineProperty(target, property, descriptor) {
      recordDom();
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      recordDom();
      return Reflect.deleteProperty(target, property);
    },
  });
  const storage = {
    getItem() {
      return null;
    },
    key() {
      return null;
    },
    get length() {
      return 0;
    },
    setItem() {
      recordSideEffect("storageMutations");
    },
    removeItem() {
      recordSideEffect("storageMutations");
    },
    clear() {
      recordSideEffect("storageMutations");
    },
  };
  const hostBridge = new Proxy(Object.create(null) as Record<string, unknown>, {
    get() {
      return (..._args: unknown[]) => {
        recordSideEffect("hostActions");
        return Promise.resolve(undefined);
      };
    },
  });
  const inertConsole = Object.freeze({
    debug() {},
    error() {},
    info() {},
    log() {},
    warn() {},
  });
  const ObservedPromise = new Proxy(Promise, {
    construct(target, args, newTarget) {
      recordSideEffect("timerRegistrations");
      return Reflect.construct(target, args, newTarget);
    },
    get(target, property, receiver) {
      if (
        property === "resolve" ||
        property === "reject" ||
        property === "all" ||
        property === "allSettled" ||
        property === "any" ||
        property === "race"
      ) {
        return (...args: unknown[]) => {
          recordSideEffect("timerRegistrations");
          const method = Reflect.get(target, property, receiver);
          return Reflect.apply(method as (...values: unknown[]) => unknown, target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PromiseConstructor;

  Object.assign(host, {
    console: inertConsole,
    document,
    electronBridge: hostBridge,
    Explodex: hostBridge,
    fetch() {
      recordSideEffect("networkCalls");
      return Promise.resolve({ ok: false, status: 0 });
    },
    localStorage: storage,
    Promise: ObservedPromise,
    sessionStorage: storage,
    setTimeout() {
      recordSideEffect("timerRegistrations");
      const id = nextTimerId;
      nextTimerId += 1;
      return id;
    },
    clearTimeout() {},
    setInterval() {
      recordSideEffect("timerRegistrations");
      const id = nextTimerId;
      nextTimerId += 1;
      return id;
    },
    clearInterval() {},
    requestAnimationFrame() {
      recordSideEffect("timerRegistrations");
      const id = nextTimerId;
      nextTimerId += 1;
      return id;
    },
    cancelAnimationFrame() {},
    queueMicrotask() {
      recordSideEffect("timerRegistrations");
    },
    XMLHttpRequest: class {
      open(): void {}
      send(): void {
        recordSideEffect("networkCalls");
      }
    },
    WebSocket: class {
      constructor() {
        recordSideEffect("networkCalls");
      }
    },
    MutationObserver: class {
      observe(): void {
        recordDom();
      }
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    },
    __explodexAppServerSend() {
      recordSideEffect("hostActions");
    },
    __bcAppServerSend() {
      recordSideEffect("hostActions");
    },
  });

  const realm = new Proxy(host, {
    set(target, property, value, receiver) {
      if (
        recording &&
        typeof property === "string" &&
        !INTERNAL_GLOBAL_WRITES.has(property)
      ) {
        recordSideEffect("globalMutations");
      }
      return Reflect.set(target, property, value, receiver);
    },
    defineProperty(target, property, descriptor) {
      if (
        recording &&
        typeof property === "string" &&
        !INTERNAL_GLOBAL_WRITES.has(property)
      ) {
        recordSideEffect("globalMutations");
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      if (
        recording &&
        typeof property === "string" &&
        !INTERNAL_GLOBAL_WRITES.has(property)
      ) {
        recordSideEffect("globalMutations");
      }
      return Reflect.deleteProperty(target, property);
    },
  });
  Reflect.set(host, "globalThis", realm);
  Reflect.set(host, "window", realm);
  Reflect.set(host, "self", realm);
  const context = createContext(realm, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
    microtaskMode: "afterEvaluate",
  });
  recording = true;
  return context;
}

/**
 * Create the private inert definition-registration harness used by build
 * validation and standalone artifact checks.
 */
export function createInertRegistrationHarness(
  host: RegistrationHost = Object.create(null) as RegistrationHost,
): InertRegistrationHarness {
  const controller = createPrivateRegistrationController(host);

  return {
    controller,
    host,
    evaluate(options) {
      return controller.evaluateInert({
        expectedPluginId: options.expectedPluginId,
        evaluate() {
          options.evaluate();
        },
      });
    },
    evaluateSource(options) {
      return controller.evaluateInertAsync({
        expectedPluginId: options.expectedPluginId,
        async evaluate(recordSideEffect) {
          const context = createObservedInertRealm(host, recordSideEffect);
          runInContext(
            `"use strict";\n${options.source}\n//# sourceURL=explodex-plugin-inert.js`,
            context,
            {
              timeout: 1_000,
              displayErrors: true,
            },
          );
          // Yield one host turn while the private hooks and observations remain
          // active. Every finite microtask chain scheduled by evaluation drains
          // before this macrotask runs, including async-function intrinsic promises.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        },
      });
    },
  };
}

export type LifecycleHarness = {
  readonly host: PluginLifecycleHost;
  apply(
    pluginId: string,
    definition: PluginDefinition,
    options?: { setupTimeoutMs?: number; teardownTimeoutMs?: number },
  ): ReturnType<PluginLifecycleHost["apply"]>;
  unload(
    pluginId: string,
    options?: { teardownTimeoutMs?: number },
  ): ReturnType<PluginLifecycleHost["unload"]>;
  snapshot(pluginId: string): TrackedResourceSnapshot | null;
  /**
   * Detect controlled tracked-resource leaks after unload.
   * Does not claim universal detection of arbitrary untracked effects.
   */
  detectTrackedLeaks(pluginId: string): {
    leaked: boolean;
    snapshot: TrackedResourceSnapshot | null;
  };
};

/** Public lifecycle harness for bounded setup/teardown and tracked-resource tests. */
export function createLifecycleHarness(options?: {
  host?: Record<string, unknown>;
}): LifecycleHarness {
  const host = createPluginLifecycleHost({
    host: options?.host,
  });
  return {
    host,
    apply(pluginId, definition, options) {
      return host.apply({
        pluginId,
        definition,
        setupTimeoutMs: options?.setupTimeoutMs,
        teardownTimeoutMs: options?.teardownTimeoutMs,
      });
    },
    unload(pluginId, options) {
      return host.unload({
        pluginId,
        teardownTimeoutMs: options?.teardownTimeoutMs,
      });
    },
    snapshot(pluginId) {
      return host.get(pluginId)?.resources ?? null;
    },
    detectTrackedLeaks(pluginId) {
      const record = host.get(pluginId);
      if (record === null) {
        return { leaked: false, snapshot: null };
      }
      const snapshot = record.resources;
      return {
        leaked:
          (snapshot.total > 0 &&
            record.status !== "applied" &&
            record.status !== "setting-up") ||
          record.supersededCleanupFailures.some(
            (failure) => failure.cleanup.residual.total > 0,
          ),
        snapshot,
      };
    },
  };
}
