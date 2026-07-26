import type { PluginLifecycle } from "@explodex/sdk";

/** Canonical required authored files for a plugin workspace. */
export const REQUIRED_WORKSPACE_FILES = [
  "package.json",
  "explodex.config.ts",
  "src/index.ts",
  "README.md",
  "tsconfig.json",
] as const;

/** Optional empty directories create may emit. */
export const OPTIONAL_EMPTY_DIRECTORIES = ["test", "assets"] as const;

/** Neutral package-manager version for generated workspaces (not artifact identity). */
export const NEUTRAL_PACKAGE_VERSION = "0.0.0";

export const SUPPORTED_LIFECYCLES: readonly PluginLifecycle[] = [
  "dynamic",
  "renderer-start",
  "app-start",
] as const;

export type DerivedPluginIdentity = {
  /** Runtime plugin ID derived from folder/package name (NAME in explodex-plugin-NAME). */
  id: string;
  /** Exact folder basename and package name. */
  packageName: string;
  /** Absolute resolved workspace root. */
  workspacePath: string;
};

export type NormalizedSourceReport = {
  id: string;
  packageName: string;
  workspacePath: string;
  version: string;
  displayName: string;
  description: string;
  entry: string;
  assets: readonly string[];
  lifecycle: PluginLifecycle;
  sdkRange: string;
  packageManagerVersion: string;
  hotSetupAllowed: boolean;
  requiredBoundary: "current" | "renderer-start" | "app-start";
  configExecutions: 1;
};

export type SourceValidationSuccess = {
  ok: true;
  report: NormalizedSourceReport;
};

export type SourceValidationFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type SourceValidationResult = SourceValidationSuccess | SourceValidationFailure;

export type CreateWorkspaceSuccess = {
  ok: true;
  workspacePath: string;
  packageName: string;
  id: string;
  files: readonly string[];
};

export type CreateWorkspaceFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type CreateWorkspaceResult = CreateWorkspaceSuccess | CreateWorkspaceFailure;
