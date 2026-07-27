/**
 * Bounded, generation-safe plugin setup/teardown application.
 * Late completion after unload/supersession cannot mark a plugin applied,
 * replace a newer generation, or register new tracked resources.
 */

import type {
  PluginDefinition,
  PluginTeardown,
} from "../types/plugin.ts";
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
} from "./constants.ts";
import { createPluginApi } from "./plugin-api.ts";
import {
  createTrackedResourceRegistry,
  type TrackedDisposalResult,
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
  readonly cleanup: TrackedDisposalResult | null;
  readonly supersededCleanupFailures: readonly SupersededCleanupFailure[];
  readonly error?: { code: string; message: string };
};

export type SupersededCleanupFailure = {
  readonly generation: number;
  readonly token: string;
  readonly cleanup: TrackedDisposalResult;
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
  readonly disposed: TrackedDisposalResult;
  readonly teardownInvoked: boolean;
};

type LiveSlot = {
  pluginId: string;
  generation: number;
  token: string;
  status: PluginApplicationStatus;
  setupCount: number;
  setupSettled: boolean;
  teardownCount: number;
  definition: PluginDefinition;
  resources: TrackedResourceRegistry;
  teardown: PluginTeardown | null;
  teardownInvoked: boolean;
  cleanup: TrackedDisposalResult | null;
  supersededCleanupFailures: SupersededCleanupFailure[];
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
    cleanup: slot.cleanup,
    supersededCleanupFailures: [...slot.supersededCleanupFailures],
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

/**
 * Create an in-memory plugin lifecycle host.
 * Not a public general activation setter; used by the runtime and testing harness.
 */
export function createPluginLifecycleHost(): PluginLifecycleHost {
  const slots = new Map<string, LiveSlot>();
  let nextGeneration = 1;
  let totalSetupInvocations = 0;
  let totalTeardownInvocations = 0;

  function mergeCleanupFailure(
    slot: LiveSlot,
    cleanup: TrackedDisposalResult,
  ): void {
    if (cleanup.failures.length === 0) return;
    const cleanupMessage = cleanup.failures
      .map((failure) => `${failure.kind}: ${failure.message}`)
      .join("; ");
    if (slot.error === undefined) {
      slot.error = {
        code: "plugin.lifecycle.cleanup-failed",
        message: `Tracked resource cleanup failed: ${cleanupMessage}`,
      };
      return;
    }
    if (!slot.error.message.includes(cleanupMessage)) {
      slot.error = {
        code: slot.error.code,
        message: `${slot.error.message}; tracked resource cleanup also failed: ${cleanupMessage}`,
      };
    }
  }

  function disposeSlotResources(slot: LiveSlot): TrackedDisposalResult {
    const cleanup = slot.resources.disposeAll();
    slot.cleanup = cleanup;
    mergeCleanupFailure(slot, cleanup);
    return cleanup;
  }

  async function invokeTeardownOnce(
    slot: LiveSlot,
    timeoutMs: number,
    label = "teardown",
  ): Promise<boolean> {
    if (slot.teardownInvoked) {
      disposeSlotResources(slot);
      return false;
    }
    slot.teardownInvoked = true;
    const teardown = slot.teardown;
    slot.teardown = null;
    if (teardown === null) {
      disposeSlotResources(slot);
      return false;
    }
    slot.teardownCount += 1;
    totalTeardownInvocations += 1;
    const finalStatus = slot.status;
    slot.status = "tearing-down";
    try {
      await withTimeout(Promise.resolve().then(() => teardown()), timeoutMs, label);
    } finally {
      disposeSlotResources(slot);
      slot.status = finalStatus;
    }
    return true;
  }

  async function cleanupOnlySetupResult(
    slot: LiveSlot,
    setupResult: PluginTeardown | void,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    slot.resources.rejectNew("cleanup-only");
    if (typeof setupResult === "function") {
      slot.teardown = setupResult;
      try {
        await invokeTeardownOnce(slot, timeoutMs, label);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Cleanup-only teardown failed";
        slot.error =
          slot.error === undefined
            ? { code: "plugin.lifecycle.teardown-failed", message }
            : {
                code: slot.error.code,
                message: `${slot.error.message}; cleanup-only teardown failed: ${message}`,
              };
      }
    } else {
      disposeSlotResources(slot);
    }
  }

  async function cleanupSupersededPrevious(
    previous: LiveSlot | undefined,
    current: LiveSlot,
    timeoutMs: number,
  ): Promise<boolean> {
    if (previous === undefined || previous === current) return true;
    if (!previous.setupSettled && previous.teardown === null) {
      // The superseded setup task still owns any teardown it may eventually return.
      // Reject and dispose tracked resources now, but leave teardown authority unconsumed.
      const cleanup = disposeSlotResources(previous);
      if (cleanup.failures.length > 0) {
        current.supersededCleanupFailures.push({
          generation: previous.generation,
          token: previous.token,
          cleanup,
        });
        current.error =
          current.error === undefined
            ? {
                code: "plugin.lifecycle.previous-cleanup-failed",
                message: `Superseded generation ${previous.generation} retained ${cleanup.residual.total} tracked resources`,
              }
            : current.error;
        return false;
      }
      return true;
    }
    let teardownError: unknown = null;
    try {
      await invokeTeardownOnce(previous, timeoutMs, "superseded-generation-teardown");
    } catch (error: unknown) {
      teardownError = error;
    }
    if (previous.cleanup?.failures.length) {
      current.supersededCleanupFailures.push({
        generation: previous.generation,
        token: previous.token,
        cleanup: previous.cleanup,
      });
    }
    if (teardownError !== null || previous.cleanup?.failures.length) {
      const message = teardownError instanceof Error
        ? teardownError.message
        : previous.cleanup?.failures.length
          ? `Superseded generation ${previous.generation} retained ${previous.cleanup.residual.total} tracked resources`
          : "Superseded generation cleanup failed";
      current.error =
        current.error === undefined
          ? {
              code: "plugin.lifecycle.previous-cleanup-failed",
              message,
            }
          : {
              code: current.error.code,
              message: `${current.error.message}; superseded generation cleanup failed: ${message}`,
            };
      return false;
    }
    return true;
  }

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
      setupSettled: false,
      teardownCount: 0,
      definition: options.definition,
      resources,
      teardown: null,
      teardownInvoked: false,
      cleanup: null,
      supersededCleanupFailures:
        previous === undefined ? [] : [...previous.supersededCleanupFailures],
    };
    slots.set(pluginId, slot);

    const api = createPluginApi({
      pluginId,
      generation,
      token,
      resources,
    });

    let setupTask: Promise<void | PluginTeardown> | null = null;
    try {
      totalSetupInvocations += 1;
      slot.setupCount = 1;
      setupTask = Promise.resolve().then(() => options.definition.setup(api));
      const setupResult = await withTimeout(
        setupTask,
        setupTimeoutMs,
        "setup",
      );
      slot.setupSettled = true;

      // Generation-safety: if unload/supersede replaced this slot, do not apply.
      const current = slots.get(pluginId);
      if (current !== slot) {
        slot.status = "superseded";
        await cleanupOnlySetupResult(
          slot,
          setupResult,
          teardownTimeoutMs,
          "superseded-setup-teardown",
        );
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
            teardownCount: slot.teardownCount,
            resources: resources.snapshot(),
            cleanup: slot.cleanup,
            supersededCleanupFailures: [...slot.supersededCleanupFailures],
            ...(slot.error !== undefined ? { error: slot.error } : {}),
          },
        };
      }

      if (slot.status === "superseded" || slot.status === "unloaded") {
        const finalStatus = slot.status;
        await cleanupOnlySetupResult(
          slot,
          setupResult,
          teardownTimeoutMs,
          "late-setup-teardown",
        );
        slot.status = finalStatus;
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
      const previousCleaned = await cleanupSupersededPrevious(
        previous,
        slot,
        teardownTimeoutMs,
      );
      if (!previousCleaned) {
        return {
          ok: false,
          code: "plugin.lifecycle.previous-cleanup-failed",
          message: slot.error?.message ?? "Superseded generation cleanup failed",
          record: toRecord(slot),
        };
      }

      return { ok: true, record: toRecord(slot) };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Plugin setup failed";
      const code = /timed out/i.test(message)
        ? "plugin.lifecycle.setup-timeout"
        : "plugin.lifecycle.setup-failed";
      const terminalStatus =
        slot.status === "unloaded" || slot.status === "superseded"
          ? slot.status
          : "failed";
      slot.status = terminalStatus;
      if (code !== "plugin.lifecycle.setup-timeout") {
        slot.setupSettled = true;
      }
      slot.error = { code, message };
      resources.rejectNew("setup-failed");
      disposeSlotResources(slot);

      if (code === "plugin.lifecycle.setup-timeout" && setupTask !== null) {
        void setupTask
          .then(
            async (lateResult) => {
              slot.setupSettled = true;
              await cleanupOnlySetupResult(
                slot,
                lateResult,
                teardownTimeoutMs,
                "late-timeout-setup-teardown",
              );
              slot.status = terminalStatus;
            },
            () => {
              // The original timed-out setup may reject later; it stays failed.
              slot.setupSettled = true;
            },
          );
      }

      await cleanupSupersededPrevious(previous, slot, teardownTimeoutMs);

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
      const disposed = disposeSlotResources(slot);
      return {
        record: toRecord(slot),
        disposed,
        teardownInvoked: false,
      };
    }

    const statusBeforeUnload = slot.status;
    const wasApplied = statusBeforeUnload === "applied";
    const wasSettingUp = statusBeforeUnload === "setting-up";
    slot.status = "unloaded";
    slot.resources.rejectNew("unloaded");

    let teardownInvoked = false;
    if (wasApplied || slot.teardown !== null) {
      try {
        teardownInvoked = await invokeTeardownOnce(slot, teardownTimeoutMs);
      } catch (error: unknown) {
        slot.error = {
          code: "plugin.lifecycle.teardown-failed",
          message: error instanceof Error ? error.message : "Plugin teardown failed",
        };
      }
    } else if (wasSettingUp) {
      // The setup task still owns any teardown it may eventually return.
      // Dispose currently tracked resources now without consuming that future teardown.
      disposeSlotResources(slot);
    } else {
      disposeSlotResources(slot);
    }

    slot.status = "unloaded";
    const disposed = slot.cleanup ?? disposeSlotResources(slot);
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
