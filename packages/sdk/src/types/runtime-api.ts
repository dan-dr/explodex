/**
 * Documented public runtime surface available to accepted plugins.
 * This is the stable authoring-facing API shape; host-private globals
 * are intentionally not exported here.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type PluginLogger = {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
};

export type ExplodexRuntimeApi = {
  readonly version: string;
  readonly log: PluginLogger;
};
