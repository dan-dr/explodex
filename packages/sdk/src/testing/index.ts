/**
 * Explicit testing harness surface for inert registration and lifecycle.
 * Not a general renderer activation API.
 */

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
  type SideEffectCanaries,
  type TrackedResourceKind,
  type TrackedResourceRegistry,
  type TrackedResourceSnapshot,
  type UnloadPluginResult,
} from "../lifecycle/index.ts";

import {
  createPluginLifecycleHost,
  createPrivateRegistrationController,
  type PluginLifecycleHost,
  type PrivateRegistrationController,
  type RegistrationHost,
  type RegistrationPhaseResult,
  type SideEffectCanaries,
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
    sideEffects?: Partial<SideEffectCanaries>;
  }): RegistrationPhaseResult;
  /** Evaluate a caller-provided function inside the private phase. */
  evaluate(options: {
    expectedPluginId: string;
    evaluate: () => void;
    sideEffects?: Partial<SideEffectCanaries>;
  }): RegistrationPhaseResult;
};

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
      return controller.evaluateInert(options);
    },
    evaluateSource(options) {
      return controller.evaluateInert({
        expectedPluginId: options.expectedPluginId,
        sideEffects: options.sideEffects,
        evaluate() {
          // Classic script semantics against the provided host object.
          const runner = new Function(
            "globalThis",
            "window",
            "console",
            `"use strict";\n${options.source}\n//# sourceURL=explodex-plugin-inert.js`,
          );
          runner(host, host, console);
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
export function createLifecycleHarness(): LifecycleHarness {
  const host = createPluginLifecycleHost();
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
        leaked: snapshot.total > 0 && record.status === "unloaded",
        snapshot,
      };
    },
  };
}
