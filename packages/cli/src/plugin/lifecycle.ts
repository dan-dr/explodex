import type { PluginLifecycle } from "@explodex/sdk";
import { SUPPORTED_LIFECYCLES } from "./types.ts";

const SUPPORTED = new Set<string>(SUPPORTED_LIFECYCLES);

/** Legacy loadable/unloadable combinations that must fail rather than translate. */
const LEGACY_LIFECYCLE_VALUES = new Set([
  "loadable",
  "unloadable",
  "always",
  "never",
  "static",
  "on-demand",
  "hot",
  "cold",
]);

export type LifecycleNormalization =
  | {
      ok: true;
      lifecycle: PluginLifecycle;
      hotSetupAllowed: boolean;
      requiredBoundary: "current" | "renderer-start" | "app-start";
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

/**
 * Accept only exact V1 lifecycles. Legacy combinations are rejected, not inferred.
 */
export function normalizeLifecycle(value: unknown): LifecycleNormalization {
  if (typeof value !== "string") {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: 'Lifecycle must be exactly "dynamic", "renderer-start", or "app-start".',
      details: { lifecycle: value },
    };
  }
  if (LEGACY_LIFECYCLE_VALUES.has(value)) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: `Legacy lifecycle "${value}" is not accepted; use dynamic, renderer-start, or app-start.`,
      details: { lifecycle: value },
    };
  }
  if (!SUPPORTED.has(value)) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: `Unknown lifecycle "${value}". Allowed: dynamic, renderer-start, app-start.`,
      details: { lifecycle: value },
    };
  }
  const lifecycle = value as PluginLifecycle;
  if (lifecycle === "dynamic") {
    return {
      ok: true,
      lifecycle,
      hotSetupAllowed: true,
      requiredBoundary: "current",
    };
  }
  if (lifecycle === "renderer-start") {
    return {
      ok: true,
      lifecycle,
      hotSetupAllowed: false,
      requiredBoundary: "renderer-start",
    };
  }
  return {
    ok: true,
    lifecycle,
    hotSetupAllowed: false,
    requiredBoundary: "app-start",
  };
}

/**
 * Pure hot-attempt predicate: only dynamic may set up in the current context.
 * Restart lifecycles report the required boundary without invoking setup.
 */
export function canHotSetup(lifecycle: PluginLifecycle): boolean {
  return lifecycle === "dynamic";
}
