/**
 * Public plugin definition and API contracts used by definePlugin.
 * Runtime host application of setup is owned by later lifecycle features.
 */

import type { ExplodexRuntimeApi } from "./runtime-api.ts";

/** API object passed to setup after the runtime accepts a definition. */
export type PluginApi = ExplodexRuntimeApi & {
  readonly pluginId: string;
};

export type PluginTeardown = () => void | Promise<void>;

export type PluginSetupResult = void | PluginTeardown | Promise<void | PluginTeardown>;

export type PluginSetup = (api: PluginApi) => PluginSetupResult;

/**
 * Declarative plugin definition. Evaluation registers this inertly;
 * setup runs only after exact acceptance.
 */
export type PluginDefinition = {
  setup: PluginSetup;
};

/**
 * Marker type returned by definePlugin for build tooling.
 * Runtime registration is private to the generated plugin IIFE.
 */
export type DefinedPlugin = PluginDefinition & {
  readonly __explodexDefinedPlugin: true;
};
