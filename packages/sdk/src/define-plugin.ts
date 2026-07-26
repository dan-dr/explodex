import type { DefinedPlugin, PluginDefinition } from "./types/plugin.ts";

/**
 * Declare one inert plugin definition.
 * Returns the same definition object marked for the build pipeline.
 * Setup is not invoked here.
 */
export function definePlugin(definition: PluginDefinition): DefinedPlugin {
  if (definition === null || typeof definition !== "object") {
    throw new TypeError("definePlugin requires a plugin definition object");
  }
  if (typeof definition.setup !== "function") {
    throw new TypeError("definePlugin requires setup(api)");
  }
  return Object.freeze({
    setup: definition.setup,
    __explodexDefinedPlugin: true as const,
  });
}
