import type { LogLevel, PluginLogger } from "../types/runtime-api.ts";

export type RuntimeLogEntry = {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail: unknown;
};

const MAX_ENTRIES = 500;

export function createLogger(scope: string, store: RuntimeLogEntry[]): PluginLogger {
  const write = (level: LogLevel, message: string, detail?: unknown): void => {
    const entry: RuntimeLogEntry = {
      ts: Date.now(),
      level,
      scope,
      message,
      detail: detail === undefined ? null : detail,
    };
    store.push(entry);
    if (store.length > MAX_ENTRIES) {
      store.splice(0, store.length - MAX_ENTRIES);
    }
    const line = `[Explodex:${scope}] ${message}`;
    if (level === "error") {
      console.error(line, detail === undefined ? "" : detail);
    } else if (level === "warn") {
      console.warn(line, detail === undefined ? "" : detail);
    } else if (level === "debug") {
      console.debug(line, detail === undefined ? "" : detail);
    } else {
      console.info(line, detail === undefined ? "" : detail);
    }
  };

  return {
    debug: (message, detail) => write("debug", message, detail),
    info: (message, detail) => write("info", message, detail),
    warn: (message, detail) => write("warn", message, detail),
    error: (message, detail) => write("error", message, detail),
  };
}
