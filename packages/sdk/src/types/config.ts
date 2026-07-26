/**
 * Canonical authoring configuration accepted by defineConfig.
 * Plugin ID and SDK range are derived outside this object.
 */

export type PluginLifecycle = "dynamic" | "renderer-start" | "app-start";

/**
 * Opaque artifact version: preserved byte-for-byte when safe.
 * Safety of concrete values is validated by the build/source pipeline (M2-F04).
 */
export type ArtifactVersion = string;

export type ExplodexConfig = {
  /** Opaque artifact version string (not package.json.version). */
  version: ArtifactVersion;
  /** Human display name. */
  displayName: string;
  /** Human description. */
  description: string;
  /** TypeScript entry relative to the plugin workspace. Default: src/index.ts */
  entry?: string;
  /** Declared asset paths relative to the plugin workspace assets root. */
  assets?: readonly string[];
  /** Exactly one supported lifecycle. */
  lifecycle: PluginLifecycle;
};
