/** Canonical installed ChatGPT.app product host (read-only). */
export const CANONICAL_BUNDLE_PATH = "/Applications/ChatGPT.app";

/** Upstream bundle identifier still exposed by build 5628. */
export const CANONICAL_BUNDLE_ID = "com.openai.codex";

/** Inner Mach-O executable name inside the app bundle. */
export const CANONICAL_EXECUTABLE_NAME = "ChatGPT";

/** Developer ID team for the signed host. */
export const CANONICAL_SIGNING_TEAM = "2DC432GLL2";

/** Mission baseline application version (CFBundleShortVersionString). */
export const MISSION_BASELINE_APP_VERSION = "26.715.61943";

/** Mission baseline application build (CFBundleVersion). */
export const MISSION_BASELINE_APP_BUILD = "5628";

/** Compatibility key / record schema version. */
export const COMPATIBILITY_SCHEMA_VERSION = 1 as const;

/**
 * Probe result schema version. Bumping this invalidates prior proofs.
 * Full probe semantics arrive in later M1 features; the version is part of the key now.
 */
export const PROBE_SCHEMA_VERSION = 1 as const;

/** Default probe tool identity until a dedicated probe package ships. */
export const DEFAULT_PROBE_TOOL_VERSION = "explodex-compat-probe/0.1.0";

/**
 * Host files whose SHA-256 values participate in the compatibility key.
 * Paths are relative to the bundle root.
 */
export const COMPATIBILITY_HOST_HASH_RELATIVE_PATHS = [
  "Contents/Info.plist",
  "Contents/MacOS/ChatGPT",
  "Contents/Resources/app.asar",
] as const;

export type CompatibilityHostHashRelativePath =
  (typeof COMPATIBILITY_HOST_HASH_RELATIVE_PATHS)[number];

/** Public documented next action when compatibility is unproven. */
export const PUBLIC_COMPATIBILITY_PROBE_HINT =
  "Run the isolated development compatibility probe on 127.0.0.1:9444 (public probe command) before launch, attach, inject, refresh, review, or apply.";

/** Operations that may run without a proven compatibility record. */
export const COMPATIBILITY_INDEPENDENT_OPERATIONS = [
  "help",
  "host-inspect",
  "status",
  "compatibility-report",
  "local-build",
  "validate",
  "package",
] as const;

/** Operations that must stop before launch or CDP evaluation when unproven/stale. */
export const COMPATIBILITY_DEPENDENT_OPERATIONS = [
  "launch-with-injection",
  "attach",
  "inject",
  "refresh",
  "review",
  "enabled-plugin-apply",
  "final-main-apply",
] as const;

export type CompatibilityIndependentOperation =
  (typeof COMPATIBILITY_INDEPENDENT_OPERATIONS)[number];

export type CompatibilityDependentOperation =
  (typeof COMPATIBILITY_DEPENDENT_OPERATIONS)[number];

export type HostOperationName =
  | CompatibilityIndependentOperation
  | CompatibilityDependentOperation;
