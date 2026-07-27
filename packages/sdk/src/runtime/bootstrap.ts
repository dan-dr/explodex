import { createLogger, type RuntimeLogEntry } from "./logger.ts";
import {
  createPluginApplicationController,
  PRIVATE_APPLY_APPROVED,
  PRIVATE_FINALIZE_APPROVED,
  type ApprovedPluginApplicationResult,
} from "./plugin-application.ts";
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
  readonly [PRIVATE_APPLY_APPROVED]: (
    input: unknown,
    evaluate: unknown,
    secret: unknown,
  ) => Promise<ApprovedPluginApplicationResult>;
  readonly [PRIVATE_FINALIZE_APPROVED]: (
    operationId: string,
    nonce: string,
  ) => void;
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
    typeof record[PRIVATE_APPLY_APPROVED] === "function" &&
    typeof record[PRIVATE_FINALIZE_APPROVED] === "function" &&
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
  const application = createPluginApplicationController({
    host: global as unknown as Record<string, unknown>,
  });
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
    onSubmitted(request, submission) {
      application.authorizeReview(request, submission);
    },
  });

  const runtime: InternalExplodexRuntime = {
    version: RUNTIME_VERSION,
    log,
    review: {
      open: (request) => review.open(request),
      cancel: (reason) => review.cancel(reason),
      cancelExact: (operationId, callbackName, reason) =>
        review.cancelExact(operationId, callbackName, reason),
    },
    [PRIVATE_APPLY_APPROVED]: (input, evaluate, secret) =>
      application.applyApproved(input, evaluate, secret),
    [PRIVATE_FINALIZE_APPROVED]: (operationId, nonce) =>
      application.finalizeApproved(operationId, nonce),
    destroy(options) {
      if (destroyed) return;
      destroyed = true;
      review.destroy();
      void application.destroy();
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
