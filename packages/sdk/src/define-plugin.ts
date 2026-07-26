import type { DefinedPlugin, PluginDefinition } from "./types/plugin.ts";

/**
 * Declare one inert plugin definition.
 * Returns a frozen definition marked for the build pipeline.
 * Setup is not invoked here; evaluation remains registration-only.
 */
export function definePlugin(definition: PluginDefinition): DefinedPlugin {
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("definePlugin requires a plugin definition object");
  }

  const record = definition as PluginDefinition & Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "setup") {
      throw new TypeError(
        `definePlugin does not accept unknown field "${key}"; only setup(api) is allowed`,
      );
    }
  }

  if (typeof record.setup !== "function") {
    throw new TypeError("definePlugin requires setup(api)");
  }

  return Object.freeze({
    setup: record.setup,
    __explodexDefinedPlugin: true as const,
  });
}

/** Runtime type guard for values returned by definePlugin. */
export function isDefinedPlugin(value: unknown): value is DefinedPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __explodexDefinedPlugin?: unknown }).__explodexDefinedPlugin === true &&
    typeof (value as { setup?: unknown }).setup === "function"
  );
}
