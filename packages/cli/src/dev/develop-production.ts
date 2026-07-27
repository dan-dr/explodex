import { watch, type FSWatcher } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { CdpAdapter } from "../cdp/adapters.ts";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import {
  createDefaultHostAdapters,
  type HostAdapters,
} from "../host/adapters.ts";
import {
  createDefaultHostStatusAdapters,
} from "../host/process-adapters.ts";
import type { HostStatusAdapters } from "../host/status.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import type { RuntimeApplicationResult } from "../plugin/application-operation.ts";
import { buildPluginWorkspace } from "../plugin/build.ts";
import { runDevInjectOperation } from "./injection-operation.ts";
import { prepareOwnedDevTarget } from "./injection-operation.ts";
import { frozenHostEquals } from "./phase0.ts";
import type {
  DevelopOwnedResource,
  DevelopRuntimeAdapters,
} from "./develop-operation.ts";
import {
  runDevelopPreflight,
  type ProductionDevelopPreflightSuccess,
} from "./develop-preflight.ts";

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function closeWatcher(watcher: FSWatcher): Promise<void> {
  return new Promise((resolve) => {
    watcher.once("close", resolve);
    watcher.close();
  });
}

export function isDevelopWatchChangeIncluded(options: {
  preflight: Pick<
    ProductionDevelopPreflightSuccess,
    "workspacePath" | "excludedPaths"
  >;
  fileName: string;
}): boolean {
  const changed = resolve(
    options.preflight.workspacePath,
    options.fileName,
  );
  if (!isWithin(options.preflight.workspacePath, changed)) return false;
  return !options.preflight.excludedPaths.some((path) =>
    isWithin(path, changed)
  );
}

function createWatcher(options: {
  preflight: ProductionDevelopPreflightSuccess;
  onChange: () => void;
  onStop: () => void;
}): DevelopOwnedResource {
  const watcher = watch(
    options.preflight.workspacePath,
    { recursive: true, persistent: true },
    (_eventType, fileName) => {
      if (fileName === null) return;
      if (!isDevelopWatchChangeIncluded({
        preflight: options.preflight,
        fileName: String(fileName),
      })) return;
      options.onChange();
    },
  );
  watcher.once("error", options.onStop);
  return {
    close: () => closeWatcher(watcher),
  };
}

function createTargetMonitor(options: {
  preflight: ProductionDevelopPreflightSuccess;
  osHome: string;
  explodexHome: string;
  explicitRoot?: string | null;
  signal?: AbortSignal;
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  cdp: CdpAdapter;
  onTargetLost: () => void;
}): DevelopOwnedResource {
  let closed = false;
  let checking = false;
  const timer = setInterval(() => {
    if (closed || checking) return;
    checking = true;
    void prepareOwnedDevTarget({
      operation: "develop",
      osHome: options.osHome,
      explodexHome: options.explodexHome,
      explicitRoot: options.explicitRoot,
      signal: options.signal,
      hostAdapters: options.hostAdapters,
      statusAdapters: options.statusAdapters,
      cdp: options.cdp,
    }).then((current) => {
      if (closed) return;
      if (
        !current.ok ||
        current.value.host.appBuild !== options.preflight.prepared.host.appBuild ||
        current.value.host.appVersion !== options.preflight.prepared.host.appVersion ||
        current.value.host.executablePath !==
          options.preflight.prepared.host.executablePath ||
        current.value.process.pid !== options.preflight.prepared.process.pid ||
        current.value.process.processStartedAt !==
          options.preflight.prepared.process.processStartedAt ||
        current.value.target.targetId !== options.preflight.target.targetId ||
        current.value.target.executionContextId !==
          options.preflight.target.executionContextId ||
        current.value.target.executionContextUniqueId !==
          options.preflight.target.executionContextUniqueId
      ) {
        options.onTargetLost();
      }
    }).catch(() => {
      if (!closed) options.onTargetLost();
    }).finally(() => {
      checking = false;
    });
  }, 750);
  timer.unref?.();
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

function identitiesEqual(
  left: {
    id: string;
    version: string;
    payloadSha256: string;
  } | null | undefined,
  right: {
    id: string;
    version: string;
    payloadSha256: string;
  } | null | undefined,
): boolean {
  return left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.id === right.id &&
    left.version === right.version &&
    left.payloadSha256 === right.payloadSha256;
}

function classifyApplicationFailure(options: {
  application: RuntimeApplicationResult | undefined;
  requested: {
    id: string;
    version: string;
    payloadSha256: string;
  };
  previous: {
    id: string;
    version: string;
    payloadSha256: string;
  } | null;
}) {
  const liveIdentity = options.application?.appliedIdentity ?? null;
  const liveDisposition = options.application === undefined ||
      options.application.status === "not-attempted"
    ? "unknown" as const
    : identitiesEqual(liveIdentity, options.requested)
    ? "requested-live" as const
    : identitiesEqual(liveIdentity, options.previous)
      ? "previous-preserved" as const
      : liveIdentity === null
        ? "plugin-absent" as const
        : "unknown" as const;
  return {
    liveDisposition,
    liveIdentity,
    stage: options.application?.stage ?? "none",
    possiblePartialEffects:
      options.application?.possiblePartialEffects ?? false,
  };
}

export async function createProductionDevelopAdapters(options: {
  workspacePath: string;
  sdkSourcePath?: string | null;
  osHome: string;
  explodexHome: string;
  explicitRoot?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  writeLine(line: string): void;
}): Promise<DevelopRuntimeAdapters> {
  const hostAdapters = await createDefaultHostAdapters();
  const statusAdapters = await createDefaultHostStatusAdapters();
  const cdp = createNodeCdpAdapter();
  let preflightValue: ProductionDevelopPreflightSuccess | null = null;
  return {
    nowIso: () => new Date().toISOString(),
    debounceMs: 75,
    cleanupBoundMs: 5_000,
    writeLine: options.writeLine,
    preflight: async () => {
      const result = await runDevelopPreflight({
        workspacePath: options.workspacePath,
        sdkSourcePath: options.sdkSourcePath,
        osHome: options.osHome,
        explodexHome: options.explodexHome,
        explicitRoot: options.explicitRoot,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        hostAdapters,
        statusAdapters,
        cdp,
      });
      if (result.ok) preflightValue = result.value;
      return result;
    },
    openWatcher: async ({ onChange, onStop }) => {
      if (preflightValue === null) {
        throw new Error("Develop watcher opened before successful preflight.");
      }
      return createWatcher({
        preflight: preflightValue,
        onChange,
        onStop,
      });
    },
    openTargetMonitor: async ({ onTargetLost }) => {
      if (preflightValue === null) {
        throw new Error("Target monitor opened before successful preflight.");
      }
      return createTargetMonitor({
        preflight: preflightValue,
        osHome: options.osHome,
        explodexHome: options.explodexHome,
        explicitRoot: options.explicitRoot,
        signal: options.signal,
        hostAdapters,
        statusAdapters,
        cdp,
        onTargetLost,
      });
    },
    buildGeneration: async ({ preflight, signal }) => {
      const built = await buildPluginWorkspace({
        workspacePath: preflight.workspacePath,
        timeoutMs: options.timeoutMs,
        shouldCommit: () => signal?.aborted !== true,
      });
      if (!built.ok) {
        return {
          ok: false,
          code: built.code,
          message: built.message,
          priorDistFingerprint: built.priorDistFingerprint,
          distFingerprintAfter: built.distFingerprintAfter,
          details: built.details,
        };
      }
      return {
        ok: true,
        pluginIdentity: {
          id: built.report.id,
          version: built.report.version,
          payloadSha256: built.payloadSha256,
        },
      };
    },
    applyGeneration: async ({
      generation,
      preflight,
      pluginIdentity,
      previousLastGood,
      signal,
    }) => {
      if (preflightValue === null) {
        return {
          ok: false,
          code: "develop.preflight-failed",
          message: "Foreground apply lost its frozen preflight authority.",
          blocked: true,
        };
      }
      const current = await prepareOwnedDevTarget({
        operation: "develop",
        osHome: options.osHome,
        explodexHome: options.explodexHome,
        explicitRoot: options.explicitRoot,
        signal,
        hostAdapters,
        statusAdapters,
        cdp,
      });
      if (
        !current.ok ||
        !frozenHostEquals(
          preflightValue.prepared.host,
          current.value.host,
        ) ||
        current.value.process.pid !== preflightValue.prepared.process.pid ||
        current.value.process.processStartedAt !==
          preflightValue.prepared.process.processStartedAt ||
        current.value.target.targetId !== preflightValue.target.targetId ||
        current.value.target.executionContextId !==
          preflightValue.target.executionContextId ||
        current.value.target.executionContextUniqueId !==
          preflightValue.target.executionContextUniqueId
      ) {
        return {
          ok: false,
          code: "cdp.target-lost",
          message:
            "The operation-frozen host, process, target, or context changed before apply.",
          blocked: true,
          details: current.ok ? undefined : current.details,
        };
      }
      const currentSdk = await resolveSdkRuntimeIdentityForCli();
      if (
        currentSdk.version !== preflight.sdkRuntimeIdentity.version ||
        currentSdk.sha256 !== preflight.sdkRuntimeIdentity.sha256
      ) {
        return {
          ok: false,
          code: "compatibility.drifted",
          message: "Generated SDK runtime identity changed after foreground preflight.",
          blocked: true,
        };
      }
      // runDevInjectOperation independently rereads the exact artifact and
      // rechecks the frozen host/process/target identity immediately before
      // renderer evaluation.
      const result = await runDevInjectOperation({
        artifactPath: preflight.distPath,
        osHome: options.osHome,
        explodexHome: options.explodexHome,
        explicitRoot: options.explicitRoot,
        timeoutMs: options.timeoutMs,
        signal,
        operationId: `develop-apply-${generation}-${Date.now()}`,
        hostAdapters,
        statusAdapters,
        cdp,
      });
      const requestedApplication = result.applications.find((application) =>
        application.id === pluginIdentity.id &&
        application.version === pluginIdentity.version &&
        application.payloadSha256 === pluginIdentity.payloadSha256
      );
      if (!result.ok) {
        const classified = classifyApplicationFailure({
          application: requestedApplication,
          requested: pluginIdentity,
          previous: previousLastGood?.pluginIdentity ?? null,
        });
        return {
          ok: false,
          code: result.code,
          message: result.message,
          blocked:
            result.code === "cdp.target-lost" ||
            result.code === "auth.required" ||
            result.code === "compatibility.unproven" ||
            result.code === "dev.ownership-uncertain" ||
            result.code === "operation.state-changed",
          details: {
            cause: result.details,
            sourceDelivered: result.sourceDelivered,
            applications: result.applications,
          },
          ...classified,
        };
      }
      if (
        requestedApplication === undefined ||
        (requestedApplication.status !== "applied" &&
          requestedApplication.status !== "unchanged") ||
        !identitiesEqual(
          requestedApplication.appliedIdentity,
          pluginIdentity,
        ) ||
        requestedApplication.error !== undefined
      ) {
        const classified = classifyApplicationFailure({
          application: requestedApplication,
          requested: pluginIdentity,
          previous: previousLastGood?.pluginIdentity ?? null,
        });
        return {
          ok: false,
          code:
            requestedApplication?.error?.code ??
              "plugin.application.incomplete",
          message:
            requestedApplication?.error?.message ??
              "The renderer did not confirm the exact requested plugin identity as fully applied.",
          blocked: false,
          details: {
            sourceDelivered: result.sourceDelivered,
            applications: result.applications,
          },
          ...classified,
        };
      }
      return {
        ok: true,
        pluginIdentity,
        target: result.target,
      };
    },
    waitForStop: async ({ signal }) => {
      if (signal?.aborted) return "interrupted";
      return await new Promise<"interrupted">((resolve) => {
        signal?.addEventListener("abort", () => resolve("interrupted"), {
          once: true,
        });
      });
    },
    cleanup: async () => ({ ok: true, residuals: [] }),
  };
}
