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
      sideEffects: SideEffectObservations;
    }
  | {
      ok: false;
      code:
        | "plugin.registration.none"
        | "plugin.registration.multiple"
        | "plugin.registration.id-mismatch"
        | "plugin.registration.out-of-phase"
        | "plugin.registration.invalid-definition"
        | "plugin.registration.evaluation-failed"
        | "plugin.registration.side-effect";
      message: string;
      registrationCount: number;
      sideEffects: SideEffectObservations;
      details?: Record<string, unknown>;
    };

export type SideEffectObservations = {
  readonly setupCalls: number;
  readonly domMutations: number;
  readonly networkCalls: number;
  readonly storageMutations: number;
  readonly timerRegistrations: number;
  readonly hostActions: number;
  readonly globalMutations: number;
};

export type SideEffectKind = Exclude<keyof SideEffectObservations, "setupCalls">;

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
    evaluate: (recordSideEffect: (kind: SideEffectKind) => void) => void;
  }): RegistrationPhaseResult;
  evaluateInertAsync(options: {
    expectedPluginId: string;
    evaluate: (
      recordSideEffect: (kind: SideEffectKind) => void,
    ) => void | Promise<void>;
  }): Promise<RegistrationPhaseResult>;
  /**
   * Attempt registration. Only succeeds during an active private phase.
   * Called by generated plugin IIFEs; not a public activation API.
   */
  register(pluginId: string, definition: unknown): void;
};

function emptySideEffects(): SideEffectObservations {
  return {
    setupCalls: 0,
    domMutations: 0,
    networkCalls: 0,
    storageMutations: 0,
    timerRegistrations: 0,
    hostActions: 0,
    globalMutations: 0,
  };
}

function hasSideEffects(observations: SideEffectObservations): boolean {
  return (
    observations.setupCalls > 0 ||
    observations.domMutations > 0 ||
    observations.networkCalls > 0 ||
    observations.storageMutations > 0 ||
    observations.timerRegistrations > 0 ||
    observations.hostActions > 0 ||
    observations.globalMutations > 0
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

  function finishEvaluation(
    expectedId: string,
    sideEffects: SideEffectObservations,
    evaluationError: unknown,
  ): RegistrationPhaseResult {
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

    if (evaluationError !== null) {
      return {
        ok: false,
        code: "plugin.registration.evaluation-failed",
        message:
          evaluationError instanceof Error
            ? `Plugin evaluation failed: ${evaluationError.message}`
            : "Plugin evaluation failed",
        registrationCount: records.length,
        sideEffects,
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
    if (only.pluginId !== expectedId) {
      return {
        ok: false,
        code: "plugin.registration.id-mismatch",
        message: `Registered plugin id "${only.pluginId}" does not match expected "${expectedId}"`,
        registrationCount: 1,
        sideEffects,
        details: {
          expectedPluginId: expectedId,
          registeredPluginId: only.pluginId,
        },
      };
    }

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
  }

  function beginEvaluation(expectedId: string): {
    sideEffects: SideEffectObservations;
    recordSideEffect: (kind: SideEffectKind) => void;
  } {
    if (active) {
      throw new Error("A private registration phase is already active");
    }
    active = true;
    expectedPluginId = expectedId;
    records = [];
    outOfPhaseAttempts = 0;
    const sideEffects = emptySideEffects();
    const mutableSideEffects = sideEffects as {
      -readonly [K in keyof SideEffectObservations]: SideEffectObservations[K];
    };
    installHooks();
    return {
      sideEffects,
      recordSideEffect(kind) {
        mutableSideEffects[kind] += 1;
      },
    };
  }

  function endEvaluation(): void {
    clearHooks();
    active = false;
    expectedPluginId = null;
  }

  return {
    get active() {
      return active;
    },
    register,
    evaluateInert(options) {
      const phase = beginEvaluation(options.expectedPluginId);
      let evaluationError: unknown = null;
      try {
        options.evaluate(phase.recordSideEffect);
      } catch (error: unknown) {
        evaluationError = error;
      } finally {
        endEvaluation();
      }
      return finishEvaluation(
        options.expectedPluginId,
        phase.sideEffects,
        evaluationError,
      );
    },
    async evaluateInertAsync(options) {
      const phase = beginEvaluation(options.expectedPluginId);
      let evaluationError: unknown = null;
      try {
        await options.evaluate(phase.recordSideEffect);
      } catch (error: unknown) {
        evaluationError = error;
      } finally {
        endEvaluation();
      }
      return finishEvaluation(
        options.expectedPluginId,
        phase.sideEffects,
        evaluationError,
      );
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
