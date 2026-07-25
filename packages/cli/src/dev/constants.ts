/** Default isolated development instance identity. */
export const DEFAULT_DEV_INSTANCE_ID = "plugin-dev" as const;

/** Relative path under the Explodex home for the default development root. */
export const DEFAULT_DEV_ROOT_RELATIVE = "dev/plugin-dev" as const;

/** Declared development CDP endpoint. Never scan or fall back. */
export const DEV_CDP_HOST = "127.0.0.1" as const;
export const DEV_CDP_PORT = 9444 as const;

/** Canonical private descendants under the development root. */
export const DEV_LAYOUT_DIRECTORIES = [
  "electron-user-data",
  "codex-home",
  "explodex-state",
  "logs",
  "locks",
] as const;

export type DevLayoutDirectory = (typeof DEV_LAYOUT_DIRECTORIES)[number];

/** Atomic development state file name under the root. */
export const DEV_STATE_FILE_NAME = "state.json" as const;

/** Persisted Phase 0 launch-isolation contract under explodex-state/. */
export const PHASE0_CONTRACT_FILE_NAME = "phase0-launch-contract.json" as const;

/** Development state schema version. */
export const DEV_STATE_SCHEMA_VERSION = 1 as const;

/** Phase 0 launch-contract schema version. */
export const PHASE0_CONTRACT_SCHEMA_VERSION = 1 as const;

/** Directory mode for private development descendants. */
export const DEV_DIRECTORY_MODE = 0o700;

/** File mode for private development state and contracts. */
export const DEV_STATE_FILE_MODE = 0o600;

/**
 * Candidate isolation knobs evaluated independently by Phase 0.
 * Retained only when each has a demonstrated effect; omitted only when not necessary.
 */
export const PHASE0_CANDIDATE_KNOBS = [
  "electron-user-data",
  "codex-home",
  "explodex-home",
  "cdp-port",
  "launch-marker",
] as const;

export type Phase0CandidateKnob = (typeof PHASE0_CANDIDATE_KNOBS)[number];

/**
 * Development lifecycle mutations that require a proven Phase 0 launch contract.
 * Path creation and read-only status do not require the contract.
 */
export const DEVELOPMENT_LIFECYCLE_MUTATIONS = [
  "dev-start",
  "dev-ensure",
  "dev-restart",
  "dev-stop",
  "dev-inject",
  "dev-recover",
  "compatibility-probe",
] as const;

export type DevelopmentLifecycleMutation =
  (typeof DEVELOPMENT_LIFECYCLE_MUTATIONS)[number];

/** Public next action when Phase 0 isolation/marker evidence is incomplete. */
export const PUBLIC_PHASE0_PROOF_HINT =
  "Complete the authorized isolated development Phase 0 launch-isolation proof on 127.0.0.1:9444 before development lifecycle mutation or compatibility probing.";

/** Forbidden keys that must never appear in development state. */
export const DEV_STATE_FORBIDDEN_KEYS = [
  "credential",
  "credentials",
  "token",
  "tokens",
  "password",
  "secret",
  "websocketSecret",
  "wsSecret",
  "authorization",
  "cookie",
  "cookies",
  "pluginSource",
  "pluginSources",
  "environment",
  "env",
  "fullEnvironment",
  "supervisorPid",
  "controllerPid",
] as const;
