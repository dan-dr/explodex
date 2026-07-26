/**
 * Public @explodex/sdk authoring surface.
 * Renderer runtime is exported separately via `@explodex/sdk/runtime`.
 */

export { defineConfig } from "./define-config.ts";
export { definePlugin } from "./define-plugin.ts";
export {
  compareSemVer,
  currentSdkSatisfiesRange,
  parseSemVer,
  satisfiesSdkRange,
  type ParsedSemVer,
} from "./compatibility.ts";
export { SDK_VERSION, type SdkVersion } from "./version.ts";

export type {
  ArtifactVersion,
  DefinedPlugin,
  ExplodexConfig,
  ExplodexRuntimeApi,
  LogLevel,
  PluginApi,
  PluginDefinition,
  PluginLifecycle,
  PluginLogger,
  PluginSetup,
  PluginSetupResult,
  PluginTeardown,
} from "./types/index.ts";
