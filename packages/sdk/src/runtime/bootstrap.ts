import { createLogger, type RuntimeLogEntry } from "./logger.ts";
import {
  createPluginApplicationController,
  PRIVATE_APPLICATION_STATUS,
  PRIVATE_APPLY_APPROVED,
  PRIVATE_FINALIZE_APPROVED,
  PRIVATE_RECONCILE_ENABLED,
  PRIVATE_UNLOAD_PLUGIN,
  type ApprovedPluginApplicationResult,
  type PluginApplicationController,
} from "./plugin-application.ts";
import {
  createPluginReviewController,
  renderPluginReviewDom,
} from "./plugin-review.ts";
import {
  buildPluginManagementModel,
  renderPluginManagementDom,
  type PluginManagementRenderHandle,
} from "./plugin-management.ts";
import type { ExplodexRuntime } from "./public.ts";
import { RUNTIME_VERSION } from "./version.ts";

const RUNTIME_MARK = "__explodexSdkRuntimeMark";
const RUNTIME_INSTANCE = "__explodexSdkRuntimeInstance";
const RUNTIME_REQUEST_IDENTITY = "__explodexSdkRuntimeRequestIdentity";
const RUNTIME_REQUEST_MARK = "__explodexSdkRuntimeRequestMark";
const PRIVATE_DESTROY_AND_WAIT = "__explodexDestroyRuntimeAndWait";

type InternalExplodexRuntime = ExplodexRuntime & {
  readonly [RUNTIME_MARK]: string;
  readonly [RUNTIME_REQUEST_MARK]: string;
  readonly [PRIVATE_APPLY_APPROVED]: (
    input: unknown,
    evaluate: unknown,
    secret: unknown,
  ) => Promise<ApprovedPluginApplicationResult>;
  readonly [PRIVATE_FINALIZE_APPROVED]: (
    operationId: string,
    nonce: string,
  ) => void;
  readonly [PRIVATE_RECONCILE_ENABLED]: (
    input: unknown,
    evaluate: unknown,
  ) => Promise<ApprovedPluginApplicationResult>;
  readonly [PRIVATE_APPLICATION_STATUS]: (
    pluginId: string,
  ) => ReturnType<PluginApplicationController["status"]>;
  readonly [PRIVATE_UNLOAD_PLUGIN]: (
    pluginId: string,
  ) => ReturnType<PluginApplicationController["unload"]>;
  readonly [PRIVATE_DESTROY_AND_WAIT]: (
    options?: { reason?: string },
  ) => Promise<void>;
};

type RuntimeHost = {
  Explodex?: InternalExplodexRuntime;
  [RUNTIME_INSTANCE]?: InternalExplodexRuntime;
  [RUNTIME_REQUEST_IDENTITY]?: string;
  console: Console;
  document?: Document;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

/**
 * Install or reuse the exact requested SDK runtime on a browser-like host.
 * CLI expressions bind this request to verified bytes plus one operation ID.
 */
export function installRuntime(global: RuntimeHost): InternalExplodexRuntime {
  const existing = global.Explodex;
  const requestIdentity = global[RUNTIME_REQUEST_IDENTITY] ??
    `version:${RUNTIME_VERSION}`;
  if (
    existing !== undefined &&
    global[RUNTIME_INSTANCE] === existing &&
    existing[RUNTIME_MARK] === RUNTIME_VERSION &&
    existing[RUNTIME_REQUEST_MARK] === requestIdentity
  ) {
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
    onDiagnostic(diagnostic) {
      log.error(diagnostic.code, {
        id: diagnostic.id,
        identity: diagnostic.identity,
        message: diagnostic.message,
      });
    },
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
  const updates = createPluginReviewController({
    host: {
      callbacks: global as unknown as Record<string, unknown>,
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => global.setTimeout(callback, delayMs),
      clearTimeout: (handle) => global.clearTimeout(handle),
    },
    surface: "update",
    render(model) {
      if (global.document === undefined || global.document.body === null) {
        throw new Error("Explodex plugin update review requires a live renderer document.");
      }
      return renderPluginReviewDom(global.document, model);
    },
    onSubmitted(request, submission) {
      application.authorizeReview(request, submission);
    },
  });
  const reconcileEnabled = application.claimEnabledReconciliation();
  if (reconcileEnabled === null) {
    throw new Error("Explodex enabled reconciliation capability was unavailable.");
  }
  let managementHandle: PluginManagementRenderHandle | null = null;
  async function destroyAndWait(options?: { reason?: string }): Promise<void> {
    if (destroyed) return;
    destroyed = true;
    review.destroy();
    updates.destroy();
    managementHandle?.close();
    managementHandle = null;
    await application.destroy();
    log.info("destroy", { reason: options?.reason ?? "explicit" });
    if (global.Explodex === runtime) {
      delete global.Explodex;
    }
    if (global[RUNTIME_INSTANCE] === runtime) {
      delete global[RUNTIME_INSTANCE];
    }
  }

  const runtime: InternalExplodexRuntime = {
    version: RUNTIME_VERSION,
    [RUNTIME_REQUEST_MARK]: requestIdentity,
    log,
    review: {
      open: (request) => {
        application.disableEnabledReconciliation();
        return review.open(request);
      },
      cancel: (reason) => review.cancel(reason),
      cancelExact: (operationId, callbackName, reason) =>
        review.cancelExact(operationId, callbackName, reason),
    },
    updates: {
      open: (request) => {
        application.disableEnabledReconciliation();
        return updates.open(request);
      },
      cancel: (reason) => updates.cancel(reason),
      cancelExact: (operationId, callbackName, reason) =>
        updates.cancelExact(operationId, callbackName, reason),
    },
    management: {
      open(request) {
        const model = buildPluginManagementModel(request);
        if (!model.ok) return model;
        if (global.document === undefined || global.document.body === null) {
          return {
            ok: false,
            message:
              "Explodex plugin management requires a live renderer document.",
          };
        }
        managementHandle?.close();
        managementHandle = renderPluginManagementDom(
          global.document,
          model,
        );
        return model;
      },
      close() {
        managementHandle?.close();
        managementHandle = null;
      },
    },
    [PRIVATE_APPLY_APPROVED]: (input, evaluate, secret) =>
      application.applyApproved(input, evaluate, secret),
    [PRIVATE_FINALIZE_APPROVED]: (operationId, nonce) =>
      application.finalizeApproved(operationId, nonce),
    [PRIVATE_RECONCILE_ENABLED]: reconcileEnabled,
    [PRIVATE_APPLICATION_STATUS]: (pluginId) =>
      application.status(pluginId),
    [PRIVATE_UNLOAD_PLUGIN]: (pluginId) =>
      application.unload(pluginId),
    [PRIVATE_DESTROY_AND_WAIT]: destroyAndWait,
    destroy(options) {
      void destroyAndWait(options);
    },
    [RUNTIME_MARK]: RUNTIME_VERSION,
  };

  global.Explodex = runtime;
  global[RUNTIME_INSTANCE] = runtime;
  log.info("ready", { version: RUNTIME_VERSION });
  return runtime;
}

export { RUNTIME_MARK, RUNTIME_INSTANCE };
