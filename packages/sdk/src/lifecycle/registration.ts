/**
 * Private inert definition-registration phase.
 * Evaluating a plugin IIFE may register exactly one definition for the
 * expected manifest ID and must not invoke setup or host effects.
 */

import { isDefinedPlugin } from "../define-plugin.ts";
import type { DefinedPlugin, PluginDefinition } from "../types/plugin.ts";
import {
  PRIVATE_PHASE_GLOBAL,
  PRIVATE_REGISTER_GLOBAL,
} from "./constants.ts";

export type RegistrationRecord = {
  readonly pluginId: string;
  readonly definition: PluginDefinition;
};

export type RegistrationPhaseResult =
  | {
      ok: true;
      registration: RegistrationRecord;
      registrationCount: 1;
      sideEffects: SideEffectCanaries;
    }
  | {
      ok: false;
      code:
        | "plugin.registration.none"
        | "plugin.registration.multiple"
        | "plugin.registration.id-mismatch"
        | "plugin.registration.out-of-phase"
        | "plugin.registration.invalid-definition"
        | "plugin.registration.side-effect";
      message: string;
      registrationCount: number;
      sideEffects: SideEffectCanaries;
      details?: Record<string, unknown>;
    };

export type SideEffectCanaries = {
  readonly setupCalls: number;
  readonly domMutations: number;
  readonly networkCalls: number;
  readonly storageMutations: number;
  readonly hostActions: number;
};

export type RegistrationHost = Record<string, unknown> & {
  [PRIVATE_REGISTER_GLOBAL]?: unknown;
  [PRIVATE_PHASE_GLOBAL]?: unknown;
};

export type PrivateRegistrationController = {
  /** True while a private evaluation phase is active. */
  readonly active: boolean;
  /**
   * Evaluate `evaluate` while accepting exactly one inert registration for
   * `expectedPluginId`. Setup is never invoked during this phase.
   */
  evaluateInert(options: {
    expectedPluginId: string;
    evaluate: () => void;
    sideEffects?: Partial<SideEffectCanaries>;
  }): RegistrationPhaseResult;
  /**
   * Attempt registration. Only succeeds during an active private phase.
   * Called by generated plugin IIFEs; not a public activation API.
   */
  register(pluginId: string, definition: unknown): void;
};

function emptySideEffects(): SideEffectCanaries {
  return {
    setupCalls: 0,
    domMutations: 0,
    networkCalls: 0,
    storageMutations: 0,
    hostActions: 0,
  };
}

function mergeSideEffects(
  base: SideEffectCanaries,
  extra?: Partial<SideEffectCanaries>,
): SideEffectCanaries {
  if (extra === undefined) return base;
  return {
    setupCalls: base.setupCalls + (extra.setupCalls ?? 0),
    domMutations: base.domMutations + (extra.domMutations ?? 0),
    networkCalls: base.networkCalls + (extra.networkCalls ?? 0),
    storageMutations: base.storageMutations + (extra.storageMutations ?? 0),
    hostActions: base.hostActions + (extra.hostActions ?? 0),
  };
}

function hasSideEffects(canaries: SideEffectCanaries): boolean {
  return (
    canaries.setupCalls > 0 ||
    canaries.domMutations > 0 ||
    canaries.networkCalls > 0 ||
    canaries.storageMutations > 0 ||
    canaries.hostActions > 0
  );
}

function asDefinition(value: unknown): PluginDefinition | null {
  if (isDefinedPlugin(value)) {
    return { setup: value.setup };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { setup?: unknown }).setup === "function"
  ) {
    return { setup: (value as PluginDefinition).setup };
  }
  // Default export of `{ default: DefinedPlugin }` from some IIFE shapes.
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value
  ) {
    return asDefinition((value as { default: unknown }).default);
  }
  return null;
}

/**
 * Create a private registration controller bound to an optional host object
 * (browser global or clean realm). Not a general renderer activation setter.
 */
export function createPrivateRegistrationController(
  host: RegistrationHost = {},
): PrivateRegistrationController {
  let active = false;
  let expectedPluginId: string | null = null;
  let records: RegistrationRecord[] = [];
  let outOfPhaseAttempts = 0;

  function register(pluginId: string, definition: unknown): void {
    if (!active || expectedPluginId === null) {
      outOfPhaseAttempts += 1;
      throw new Error(
        "Plugin definition registration is only allowed during the private evaluation phase",
      );
    }
    const normalized = asDefinition(definition);
    if (normalized === null) {
      throw new Error("Plugin registration requires a definePlugin definition with setup(api)");
    }
    records.push({
      pluginId,
      definition: normalized,
    });
  }

  // Install host hooks only for the duration of evaluateInert when active.
  function installHooks(): void {
    host[PRIVATE_PHASE_GLOBAL] = true;
    host[PRIVATE_REGISTER_GLOBAL] = register;
  }

  function clearHooks(): void {
    delete host[PRIVATE_PHASE_GLOBAL];
    delete host[PRIVATE_REGISTER_GLOBAL];
  }

  return {
    get active() {
      return active;
    },
    register,
    evaluateInert(options) {
      if (active) {
        throw new Error("A private registration phase is already active");
      }

      active = true;
      expectedPluginId = options.expectedPluginId;
      records = [];
      outOfPhaseAttempts = 0;
      const sideEffects = mergeSideEffects(emptySideEffects(), options.sideEffects);

      installHooks();
      try {
        options.evaluate();
      } finally {
        clearHooks();
        active = false;
        expectedPluginId = null;
      }

      if (hasSideEffects(sideEffects)) {
        return {
          ok: false,
          code: "plugin.registration.side-effect",
          message:
            "Plugin evaluation performed setup or host side effects during inert registration",
          registrationCount: records.length,
          sideEffects,
          details: { sideEffects },
        };
      }

      if (outOfPhaseAttempts > 0 && records.length === 0) {
        return {
          ok: false,
          code: "plugin.registration.out-of-phase",
          message: "Plugin registration was attempted outside the private evaluation phase",
          registrationCount: 0,
          sideEffects,
          details: { outOfPhaseAttempts },
        };
      }

      if (records.length === 0) {
        return {
          ok: false,
          code: "plugin.registration.none",
          message: "Plugin evaluation registered zero definitions",
          registrationCount: 0,
          sideEffects,
        };
      }

      if (records.length > 1) {
        return {
          ok: false,
          code: "plugin.registration.multiple",
          message: `Plugin evaluation registered ${records.length} definitions; exactly one is required`,
          registrationCount: records.length,
          sideEffects,
          details: {
            pluginIds: records.map((record) => record.pluginId),
          },
        };
      }

      const only = records[0]!;
      if (only.pluginId !== options.expectedPluginId) {
        return {
          ok: false,
          code: "plugin.registration.id-mismatch",
          message: `Registered plugin id "${only.pluginId}" does not match expected "${options.expectedPluginId}"`,
          registrationCount: 1,
          sideEffects,
          details: {
            expectedPluginId: options.expectedPluginId,
            registeredPluginId: only.pluginId,
          },
        };
      }

      // Freeze definition surface so harness consumers cannot mutate setup binding casually.
      const frozen: DefinedPlugin = Object.freeze({
        setup: only.definition.setup,
        __explodexDefinedPlugin: true as const,
      });

      return {
        ok: true,
        registration: {
          pluginId: only.pluginId,
          definition: frozen,
        },
        registrationCount: 1,
        sideEffects,
      };
    },
  };
}

/**
 * Helper used by generated classic-script IIFEs to register a definition
 * when a private phase is active. Safe no-op throw outside phase.
 */
export function registerPluginDefinition(
  host: RegistrationHost,
  pluginId: string,
  definition: unknown,
): void {
  const hook = host[PRIVATE_REGISTER_GLOBAL];
  if (typeof hook !== "function") {
    throw new Error(
      "Plugin definition registration is only allowed during the private evaluation phase",
    );
  }
  (hook as (id: string, definition: unknown) => void)(pluginId, definition);
}
