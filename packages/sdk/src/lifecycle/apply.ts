/**
 * Bounded, generation-safe plugin setup/teardown application.
 * Late completion after unload/supersession cannot mark a plugin applied,
 * replace a newer generation, or register new tracked resources.
 */

import type { PluginDefinition, PluginTeardown } from "../types/plugin.ts";
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
} from "./constants.ts";
import { createPluginApi } from "./plugin-api.ts";
import {
  createTrackedResourceRegistry,
  type TrackedResourceRegistry,
  type TrackedResourceSnapshot,
} from "./tracked-resources.ts";

export type PluginApplicationStatus =
  | "idle"
  | "setting-up"
  | "applied"
  | "failed"
  | "tearing-down"
  | "unloaded"
  | "superseded";

export type PluginApplicationRecord = {
  readonly pluginId: string;
  readonly generation: number;
  readonly token: string;
  readonly status: PluginApplicationStatus;
  readonly setupCount: number;
  readonly teardownCount: number;
  readonly resources: TrackedResourceSnapshot;
  readonly error?: { code: string; message: string };
};

export type ApplyPluginResult =
  | {
      ok: true;
      record: PluginApplicationRecord;
    }
  | {
      ok: false;
      record: PluginApplicationRecord;
      code: string;
      message: string;
    };

export type UnloadPluginResult = {
  readonly record: PluginApplicationRecord;
  readonly disposed: TrackedResourceSnapshot;
  readonly teardownInvoked: boolean;
};

type LiveSlot = {
  pluginId: string;
  generation: number;
  token: string;
  status: PluginApplicationStatus;
  setupCount: number;
  teardownCount: number;
  definition: PluginDefinition;
  resources: TrackedResourceRegistry;
  teardown: PluginTeardown | null;
  teardownInvoked: boolean;
  error?: { code: string; message: string };
};

export type PluginLifecycleHost = {
  apply(options: {
    pluginId: string;
    definition: PluginDefinition;
    setupTimeoutMs?: number;
    teardownTimeoutMs?: number;
  }): Promise<ApplyPluginResult>;
  unload(options: {
    pluginId: string;
    teardownTimeoutMs?: number;
  }): Promise<UnloadPluginResult | null>;
  get(pluginId: string): PluginApplicationRecord | null;
  list(): PluginApplicationRecord[];
  /** Test/harness: total setup invocations across all generations. */
  readonly totalSetupInvocations: number;
  readonly totalTeardownInvocations: number;
};

function newToken(pluginId: string, generation: number): string {
  return `${pluginId}:${generation}:${Math.random().toString(36).slice(2, 10)}`;
}

function toRecord(slot: LiveSlot): PluginApplicationRecord {
  return {
    pluginId: slot.pluginId,
    generation: slot.generation,
    token: slot.token,
    status: slot.status,
    setupCount: slot.setupCount,
    teardownCount: slot.teardownCount,
    resources: slot.resources.snapshot(),
    ...(slot.error !== undefined ? { error: slot.error } : {}),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function invokeTeardownOnce(
  slot: LiveSlot,
  timeoutMs: number,
): Promise<void> {
  if (slot.teardownInvoked) return;
  slot.teardownInvoked = true;
  const teardown = slot.teardown;
  slot.teardown = null;
  if (teardown === null) {
    slot.resources.disposeAll();
    return;
  }
  slot.status = "tearing-down";
  try {
    await withTimeout(Promise.resolve().then(() => teardown()), timeoutMs, "teardown");
    slot.teardownCount += 1;
  } finally {
    slot.resources.disposeAll();
  }
}

/**
 * Create an in-memory plugin lifecycle host.
 * Not a public general activation setter; used by the runtime and testing harness.
 */
export function createPluginLifecycleHost(): PluginLifecycleHost {
  const slots = new Map<string, LiveSlot>();
  let nextGeneration = 1;
  let totalSetupInvocations = 0;
  let totalTeardownInvocations = 0;

  async function apply(options: {
    pluginId: string;
    definition: PluginDefinition;
    setupTimeoutMs?: number;
    teardownTimeoutMs?: number;
  }): Promise<ApplyPluginResult> {
    const setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
    const pluginId = options.pluginId;

    const previous = slots.get(pluginId);
    if (
      previous !== undefined &&
      (previous.status === "applied" || previous.status === "setting-up")
    ) {
      // Supersede: mark previous so late work cannot resurrect it.
      previous.status = "superseded";
      previous.resources.rejectNew("superseded");
      // Teardown previous after new setup attempt policy: prepare new first.
    }

    const generation = nextGeneration;
    nextGeneration += 1;
    const token = newToken(pluginId, generation);
    const resources = createTrackedResourceRegistry({ generation, token });
    const slot: LiveSlot = {
      pluginId,
      generation,
      token,
      status: "setting-up",
      setupCount: 0,
      teardownCount: 0,
      definition: options.definition,
      resources,
      teardown: null,
      teardownInvoked: false,
    };
    slots.set(pluginId, slot);

    const api = createPluginApi({
      pluginId,
      generation,
      token,
      resources,
    });

    try {
      totalSetupInvocations += 1;
      slot.setupCount = 1;
      const setupResult = await withTimeout(
        Promise.resolve().then(() => options.definition.setup(api)),
        setupTimeoutMs,
        "setup",
      );

      // Generation-safety: if unload/supersede replaced this slot, do not apply.
      const current = slots.get(pluginId);
      if (current !== slot) {
        resources.rejectNew("superseded");
        if (typeof setupResult === "function") {
          // Cleanup-only mode for late-resolving superseded setup.
          try {
            await withTimeout(
              Promise.resolve().then(() => (setupResult as PluginTeardown)()),
              teardownTimeoutMs,
              "superseded-setup-teardown",
            );
            totalTeardownInvocations += 1;
          } catch {
            // Reported as superseded; cleanup best-effort.
          }
        }
        resources.disposeAll();
        return {
          ok: false,
          code: "plugin.lifecycle.superseded",
          message: "Setup completed after the load generation was superseded or unloaded",
          record: {
            pluginId,
            generation,
            token,
            status: "superseded",
            setupCount: 1,
            teardownCount: typeof setupResult === "function" ? 1 : 0,
            resources: resources.snapshot(),
          },
        };
      }

      if (slot.status === "superseded" || slot.status === "unloaded") {
        resources.rejectNew(slot.status);
        if (typeof setupResult === "function") {
          try {
            await withTimeout(
              Promise.resolve().then(() => (setupResult as PluginTeardown)()),
              teardownTimeoutMs,
              "late-setup-teardown",
            );
            totalTeardownInvocations += 1;
            slot.teardownCount += 1;
          } catch {
            // best-effort
          }
        }
        resources.disposeAll();
        return {
          ok: false,
          code: "plugin.lifecycle.superseded",
          message: "Setup completed after the load generation was superseded or unloaded",
          record: toRecord(slot),
        };
      }

      if (typeof setupResult === "function") {
        slot.teardown = setupResult;
      }
      slot.status = "applied";

      // If there was a previous applied generation, tear it down now.
      if (previous !== undefined && previous !== slot) {
        try {
          await invokeTeardownOnce(previous, teardownTimeoutMs);
          totalTeardownInvocations += previous.teardownCount > 0 ? 0 : 0;
          // Count actual teardown invocations from previous.
          if (previous.teardownInvoked) {
            totalTeardownInvocations += 1;
          }
        } catch {
          // Prior generation cleanup failures are recorded but do not roll back new apply.
        }
      }

      return { ok: true, record: toRecord(slot) };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Plugin setup failed";
      const code = /timed out/i.test(message)
        ? "plugin.lifecycle.setup-timeout"
        : "plugin.lifecycle.setup-failed";
      slot.status = "failed";
      slot.error = { code, message };
      resources.rejectNew("setup-failed");
      resources.disposeAll();

      // Restore previous generation if we superseded it in-memory but new setup failed.
      if (previous !== undefined && previous !== slot && previous.status === "superseded") {
        previous.status = "applied";
        slots.set(pluginId, previous);
      } else if (slots.get(pluginId) === slot) {
        // Leave failed slot for inspection; not successfully applied.
      }

      return {
        ok: false,
        code,
        message,
        record: toRecord(slot),
      };
    }
  }

  async function unload(options: {
    pluginId: string;
    teardownTimeoutMs?: number;
  }): Promise<UnloadPluginResult | null> {
    const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
    const slot = slots.get(options.pluginId);
    if (slot === undefined) {
      return null;
    }

    // Idempotent: repeated unload does not re-invoke teardown.
    if (slot.status === "unloaded") {
      return {
        record: toRecord(slot),
        disposed: slot.resources.snapshot(),
        teardownInvoked: false,
      };
    }

    const wasApplied = slot.status === "applied" || slot.status === "setting-up";
    slot.status = "unloaded";
    slot.resources.rejectNew("unloaded");

    let teardownInvoked = false;
    if (wasApplied || slot.teardown !== null) {
      const beforeCount = slot.teardownCount;
      try {
        await invokeTeardownOnce(slot, teardownTimeoutMs);
        if (slot.teardownCount > beforeCount) {
          totalTeardownInvocations += 1;
          teardownInvoked = true;
        } else if (slot.teardownInvoked && beforeCount === 0 && slot.teardownCount === 0) {
          // teardown function was null; resources still disposed.
          teardownInvoked = false;
        } else if (slot.teardownInvoked) {
          teardownInvoked = true;
        }
      } catch (error: unknown) {
        slot.error = {
          code: "plugin.lifecycle.teardown-failed",
          message: error instanceof Error ? error.message : "Plugin teardown failed",
        };
      }
    } else {
      slot.resources.disposeAll();
    }

    slot.status = "unloaded";
    const disposed = slot.resources.snapshot();
    return {
      record: toRecord(slot),
      disposed,
      teardownInvoked,
    };
  }

  return {
    apply,
    unload,
    get(pluginId) {
      const slot = slots.get(pluginId);
      return slot === undefined ? null : toRecord(slot);
    },
    list() {
      return [...slots.values()].map(toRecord);
    },
    get totalSetupInvocations() {
      return totalSetupInvocations;
    },
    get totalTeardownInvocations() {
      return totalTeardownInvocations;
    },
  };
}
