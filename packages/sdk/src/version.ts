/**
 * Authoritative SDK version string for authoring, packaging, and runtime.
 * Keep synchronized with packages/sdk/package.json version.
 */
export const SDK_VERSION = "1.2.0" as const;

export type SdkVersion = typeof SDK_VERSION;
