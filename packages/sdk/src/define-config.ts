import type { ExplodexConfig, PluginLifecycle } from "./types/config.ts";

const LIFECYCLES: ReadonlySet<PluginLifecycle> = new Set([
  "dynamic",
  "renderer-start",
  "app-start",
]);

/** Canonical keys accepted by defineConfig. All others fail closed. */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "version",
  "displayName",
  "description",
  "entry",
  "assets",
  "lifecycle",
]);

/** Fields that would duplicate identity or compatibility authority. */
const FORBIDDEN_AUTHORITY_MESSAGES: Readonly<Record<string, string>> = {
  id: "defineConfig does not accept id; ID is derived from the package name",
  sdkRange: 'defineConfig does not accept sdkRange; use peerDependencies["@explodex/sdk"]',
  permissions: "defineConfig does not accept permissions; V1 has no permission model",
  capabilities: "defineConfig does not accept capabilities; V1 has no capability model",
  repository: "defineConfig does not accept repository authority",
  installScripts: "defineConfig does not accept install scripts",
  scripts: "defineConfig does not accept package scripts",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept only canonical authoring metadata.
 * Plugin ID and sdkRange are derived outside this object and are rejected here.
 * Unknown fields fail closed with actionable diagnostics.
 */
export function defineConfig(config: ExplodexConfig): ExplodexConfig {
  if (!isRecord(config)) {
    throw new TypeError("defineConfig requires a configuration object");
  }

  for (const key of Object.keys(config)) {
    const authorityMessage = FORBIDDEN_AUTHORITY_MESSAGES[key];
    if (authorityMessage !== undefined) {
      throw new TypeError(authorityMessage);
    }
    if (!ALLOWED_KEYS.has(key)) {
      throw new TypeError(
        `defineConfig does not accept unknown field "${key}"; allowed: version, displayName, description, entry, assets, lifecycle`,
      );
    }
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
