/**
 * Public @explodex/sdk authoring surface.
 * Renderer runtime is exported separately via `@explodex/sdk/runtime`.
 */

export { defineConfig } from "./define-config.ts";
export { definePlugin, isDefinedPlugin } from "./define-plugin.ts";
export {
  compareSemVer,
  currentSdkSatisfiesRange,
  evaluateSdkCompatibility,
  parseSemVer,
  satisfiesSdkRange,
  type ParsedSemVer,
  type SdkCompatibilityReason,
  type SdkCompatibilityVerdict,
} from "./compatibility.ts";
export { SDK_VERSION, type SdkVersion } from "./version.ts";

export type {
  ArtifactVersion,
  DefinedPlugin,
  ExplodexConfig,
  ExplodexRuntimeApi,
  LogLevel,
  PluginAssetHandle,
  PluginAssets,
  PluginApi,
  PluginDefinition,
  PluginLifecycle,
  PluginLogger,
  PluginSetup,
  PluginSetupResult,
  PluginTeardown,
  PluginTrackedResources,
  TrackedEventListener,
  TrackedEventTarget,
  TrackedMountNode,
  TrackedObserver,
} from "./types/index.ts";
export type { ExplodexRuntime } from "./runtime/public.ts";

export {
  DEFAULT_SETUP_TIMEOUT_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
} from "./lifecycle/constants.ts";
