/**
 * Documented finite bounds for plugin setup and teardown.
 * Late completion after unload/supersession cannot resurrect state.
 */

/** Default application-level bound for awaiting plugin setup. */
export const DEFAULT_SETUP_TIMEOUT_MS = 5_000;

/** Default application-level bound for awaiting plugin teardown. */
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 5_000;

/** Private registration phase marker (not a public activation API). */
export const PRIVATE_REGISTER_GLOBAL = "__EXPLODEX_PRIVATE_REGISTER__" as const;

/** Private phase state flag used by the inert registration harness. */
export const PRIVATE_PHASE_GLOBAL = "__EXPLODEX_PRIVATE_PHASE__" as const;
