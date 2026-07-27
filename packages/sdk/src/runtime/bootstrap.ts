import { createLogger, type RuntimeLogEntry } from "./logger.ts";
import {
  createPluginReviewController,
  renderPluginReviewDom,
  type PluginReviewRequest,
  type ReviewOutcome,
} from "./plugin-review.ts";
import type { ExplodexRuntime } from "./public.ts";
import { RUNTIME_VERSION } from "./version.ts";

const RUNTIME_MARK = "__explodexSdkRuntimeMark";
const RUNTIME_INSTANCE = "__explodexSdkRuntimeInstance";

type InternalExplodexRuntime = ExplodexRuntime & {
  readonly [RUNTIME_MARK]: string;
};

type RuntimeHost = {
  Explodex?: InternalExplodexRuntime;
  [RUNTIME_INSTANCE]?: InternalExplodexRuntime;
  console: Console;
  document?: Document;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

function isExplodexRuntime(value: unknown): value is InternalExplodexRuntime {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === "string" &&
    typeof record.destroy === "function" &&
    typeof record.review === "object" &&
    record[RUNTIME_MARK] === RUNTIME_VERSION
  );
}

/**
 * Install or reuse the single documented SDK runtime on a browser-like host.
 * Repeated evaluation converges on one live instance for the same version.
 */
export function installRuntime(global: RuntimeHost): InternalExplodexRuntime {
  const existing = global.Explodex;
  if (isExplodexRuntime(existing) && global[RUNTIME_INSTANCE] === existing) {
    return existing;
  }

  if (existing && typeof existing.destroy === "function") {
    try {
      existing.destroy({ reason: "reload" });
    } catch (error) {
      global.console.warn("[Explodex] previous runtime destroy failed", error);
    }
  }

  const entries: RuntimeLogEntry[] = [];
  const log = createLogger("runtime", entries);
  let destroyed = false;
  const review = createPluginReviewController({
    host: {
      callbacks: global as unknown as Record<string, unknown>,
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => global.setTimeout(callback, delayMs),
      clearTimeout: (handle) => global.clearTimeout(handle),
    },
    render(model) {
      if (global.document === undefined || global.document.body === null) {
        throw new Error("Explodex plugin review requires a live renderer document.");
      }
      return renderPluginReviewDom(global.document, model);
    },
  });

  const runtime: InternalExplodexRuntime = {
    version: RUNTIME_VERSION,
    log,
    review: {
      open: (request) => review.open(request),
      cancel: (reason) => review.cancel(reason),
    },
    destroy(options) {
      if (destroyed) return;
      destroyed = true;
      review.destroy();
      log.info("destroy", { reason: options?.reason ?? "explicit" });
      if (global.Explodex === runtime) {
        delete global.Explodex;
      }
      if (global[RUNTIME_INSTANCE] === runtime) {
        delete global[RUNTIME_INSTANCE];
      }
    },
    [RUNTIME_MARK]: RUNTIME_VERSION,
  };

  global.Explodex = runtime;
  global[RUNTIME_INSTANCE] = runtime;
  log.info("ready", { version: RUNTIME_VERSION });
  return runtime;
}

export { RUNTIME_MARK, RUNTIME_INSTANCE };
