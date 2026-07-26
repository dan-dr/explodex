import type { ExplodexConfig, PluginLifecycle } from "./types/config.ts";

const LIFECYCLES: ReadonlySet<PluginLifecycle> = new Set([
  "dynamic",
  "renderer-start",
  "app-start",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept only canonical authoring metadata.
 * ID and sdkRange are derived elsewhere and rejected if present.
 */
export function defineConfig(config: ExplodexConfig): ExplodexConfig {
  if (!isRecord(config)) {
    throw new TypeError("defineConfig requires a configuration object");
  }

  // Reject identity/compatibility authority fields even when cast away at the call site.
  if ("id" in config) {
    throw new TypeError("defineConfig does not accept id; ID is derived from the package name");
  }
  if ("sdkRange" in config) {
    throw new TypeError(
      'defineConfig does not accept sdkRange; use peerDependencies["@explodex/sdk"]',
    );
  }

  if (typeof config.version !== "string" || config.version.trim().length === 0) {
    throw new TypeError("defineConfig requires a non-empty version string");
  }
  if (typeof config.displayName !== "string" || config.displayName.trim().length === 0) {
    throw new TypeError("defineConfig requires a non-empty displayName string");
  }
  if (typeof config.description !== "string") {
    throw new TypeError("defineConfig requires a description string");
  }
  if (typeof config.lifecycle !== "string" || !LIFECYCLES.has(config.lifecycle as PluginLifecycle)) {
    throw new TypeError(
      'defineConfig lifecycle must be "dynamic", "renderer-start", or "app-start"',
    );
  }
  if (config.entry !== undefined && typeof config.entry !== "string") {
    throw new TypeError("defineConfig entry must be a string when provided");
  }
  if (config.assets !== undefined) {
    if (!Array.isArray(config.assets) || !config.assets.every((item) => typeof item === "string")) {
      throw new TypeError("defineConfig assets must be an array of strings when provided");
    }
  }

  const result: ExplodexConfig = {
    version: config.version,
    displayName: config.displayName,
    description: config.description,
    lifecycle: config.lifecycle as PluginLifecycle,
  };
  if (config.entry !== undefined) result.entry = config.entry;
  if (config.assets !== undefined) result.assets = Object.freeze([...config.assets]);
  return Object.freeze(result);
}
