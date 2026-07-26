/** Canonical installed ChatGPT.app product host (read-only). */
export const CANONICAL_BUNDLE_PATH = "/Applications/ChatGPT.app";

/** Upstream bundle identifier still exposed by build 5628. */
export const CANONICAL_BUNDLE_ID = "com.openai.codex";

/** Inner Mach-O executable name inside the app bundle. */
export const CANONICAL_EXECUTABLE_NAME = "ChatGPT";

/** Developer ID team for the signed host. */
export const CANONICAL_SIGNING_TEAM = "2DC432GLL2";

/**
 * Historical readiness observation (2026-07-22) application version.
 * Not an acceptance constant or allowlist; every live operation freezes the
 * then-current exact canonical host identity instead.
 */
export const MISSION_BASELINE_APP_VERSION = "26.715.61943";

/**
 * Historical readiness observation (2026-07-22) application build.
 * Not an acceptance constant or allowlist; every live operation freezes the
 * then-current exact canonical host identity instead.
 */
export const MISSION_BASELINE_APP_BUILD = "5628";

/**
 * Historical read-only observation (2026-07-25) application version.
 * Evidence history only; never used as a build-choice gate.
 */
export const HISTORICAL_OBSERVED_APP_VERSION_2026_07_25 = "26.721.41059";

/**
 * Historical read-only observation (2026-07-25) application build.
 * Evidence history only; never used as a build-choice gate.
 */
export const HISTORICAL_OBSERVED_APP_BUILD_2026_07_25 = "5848";

/** The only declared role endpoints. Normal commands never scan or fall back. */
export const DECLARED_ROLE_ENDPOINTS = {
  main: { host: "127.0.0.1", port: 9333 },
  development: { host: "127.0.0.1", port: 9444 },
} as const;

/** The only compatible renderer page URL. */
export const EXACT_RENDERER_URL = "app://-/index.html" as const;

/** Compatibility key / record schema version. */
export const COMPATIBILITY_SCHEMA_VERSION = 1 as const;

/**
 * Probe result schema version. Bumping this invalidates prior proofs.
 * v2 requires unique process/listener/target/context inventories and one validated
 * successful benign request/response through an actually invoked bridge transport.
 */
export const PROBE_SCHEMA_VERSION = 2 as const;

/**
 * Default probe tool identity until a dedicated probe package ships.
 * Bumping invalidates pre-repair persisted proofs (M1-F05R2).
 */
export const DEFAULT_PROBE_TOOL_VERSION = "explodex-compat-probe/0.2.0";

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
