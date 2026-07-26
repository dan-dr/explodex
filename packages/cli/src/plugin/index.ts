export { createPluginWorkspace } from "./create.ts";
export { loadExplodexConfigOnce } from "./config-load.ts";
export {
  deriveIdFromPackageName,
  deriveIdFromWorkspacePath,
  deriveMatchingIdentity,
  displayNameFromId,
} from "./identity.ts";
export { canHotSetup, normalizeLifecycle } from "./lifecycle.ts";
export { parsePluginPackageJson } from "./package-json.ts";
export { validatePluginSource } from "./validate.ts";
export { buildPluginWorkspace, readBuiltPluginIndex } from "./build.ts";
export { bundlePluginIife, fingerprintDist } from "./bundle.ts";
export {
  decodeOpaqueVersionComponent,
  encodeOpaqueVersionComponent,
  validateOpaqueVersion,
} from "./version.ts";
export type {
  CreateWorkspaceResult,
  NormalizedSourceReport,
  SourceValidationResult,
} from "./types.ts";
export type { PluginBuildResult } from "./build.ts";
export type { BundleResult, BundleImportDiagnostic } from "./bundle.ts";
