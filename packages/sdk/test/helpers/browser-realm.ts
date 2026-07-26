/**
 * Clean browser-realm harness for classic IIFE evaluation.
 * process/Buffer/require/module/exports/Bun/Electron are absent by construction.
 */

export type BrowserRealm = {
  global: Record<string, unknown> & {
    window: Record<string, unknown>;
    console: Console;
    Explodex?: {
      version: string;
      destroy: (options?: { reason?: string }) => void;
      log: {
        debug: (message: string, detail?: unknown) => void;
        info: (message: string, detail?: unknown) => void;
        warn: (message: string, detail?: unknown) => void;
        error: (message: string, detail?: unknown) => void;
      };
    };
  };
  evaluate(source: string): unknown;
  uncaughtErrors: unknown[];
};

export function createBrowserRealm(): BrowserRealm {
  const uncaughtErrors: unknown[] = [];
  const realmGlobal: BrowserRealm["global"] = {
    console,
    window: {} as Record<string, unknown>,
  };
  realmGlobal.window = realmGlobal;
  realmGlobal.globalThis = realmGlobal;

  // Explicitly ensure forbidden Node/Electron globals are not present.
  for (const key of [
    "process",
    "Buffer",
    "require",
    "module",
    "exports",
    "Bun",
    "electron",
    "__dirname",
    "__filename",
  ]) {
    if (key in realmGlobal) {
      delete realmGlobal[key];
    }
  }

  return {
    global: realmGlobal,
    uncaughtErrors,
    evaluate(source: string): unknown {
      try {
        // Classic script semantics: no module scope; free `this` is the global.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const runner = new Function(
          "window",
          "globalThis",
          "console",
          `"use strict";\n${source}\n//# sourceURL=explodex-runtime.iife.js`,
        );
        return runner(realmGlobal, realmGlobal, console);
      } catch (error) {
        uncaughtErrors.push(error);
        throw error;
      }
    },
  };
}
