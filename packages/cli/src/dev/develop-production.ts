import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
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
import { runCompatibilityProbe } from "../host/probe-operation.ts";
import type { RuntimeApplicationResult } from "../plugin/application-operation.ts";
import { buildPluginWorkspace } from "../plugin/build.ts";
import { runDevInjectOperation } from "./injection-operation.ts";
import { prepareOwnedDevTarget } from "./injection-operation.ts";
import { frozenHostEquals } from "./phase0.ts";
import { describeDevLayout } from "./layout.ts";
import { runDevLifecycleOperation } from "./lifecycle-operation.ts";
import { buildLocalSdkSource } from "./local-sdk.ts";
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
  > & { watchedPaths?: string[] };
  fileName: string;
  watchedRoot?: string;
}): boolean {
  const changed = resolve(
    options.watchedRoot ?? options.preflight.workspacePath,
    options.fileName,
  );
  if (
    !(options.preflight.watchedPaths ?? [options.preflight.workspacePath]).some(
      (root) => isWithin(root, changed),
    )
  ) return false;
  return !options.preflight.excludedPaths.some((path) =>
    isWithin(path, changed)
  );
}

function createWatcher(options: {
  preflight: ProductionDevelopPreflightSuccess;
  onChange: () => void;
  onStop: () => void;
}): DevelopOwnedResource {
  const watchers = options.preflight.watchedPaths.map((watchedRoot) => {
    const watcher = watch(
      watchedRoot,
      { recursive: true, persistent: true },
      (_eventType, fileName) => {
        if (fileName === null) return;
        if (!isDevelopWatchChangeIncluded({
          preflight: options.preflight,
          fileName: String(fileName),
          watchedRoot,
        })) return;
        options.onChange();
      },
    );
    watcher.once("error", options.onStop);
    return watcher;
  });
  return {
    close: async () => {
      await Promise.all(watchers.map(closeWatcher));
    },
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
      requireCompatibility: false,
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
      let localSdkRuntime:
        | {
            version: string;
            sha256: string;
            declarationsSha256: string;
            sourcePath: string;
            source: string;
          }
        | null = null;
      if (preflightValue?.localSdkSource !== undefined) {
        const sdkBuilt = await buildLocalSdkSource({
          source: preflightValue.localSdkSource,
          timeoutMs: options.timeoutMs,
          signal,
        });
        if (!sdkBuilt.ok) {
          return {
            ok: false,
            code: sdkBuilt.code,
            message: sdkBuilt.message,
            failureKind: "sdk",
            priorDistFingerprint: sdkBuilt.priorDistFingerprint,
            distFingerprintAfter: sdkBuilt.distFingerprintAfter,
          };
        }
        const source = await readFile(
          sdkBuilt.source.runtime.runtimePath,
          "utf8",
        );
        localSdkRuntime = {
          version: sdkBuilt.source.runtime.version,
          sha256: sdkBuilt.source.runtime.sha256,
          declarationsSha256:
            sdkBuilt.source.runtime.declarationsSha256,
          sourcePath: sdkBuilt.source.runtime.runtimePath,
          source,
        };
        const compatibility = await runCompatibilityProbe({
          adapters: hostAdapters,
          explodexHome: options.explodexHome,
          phase0ContractPath: describeDevLayout(
            preflightValue.prepared.snapshot.rootPath,
          ).phase0ContractPath,
          sdkRuntime: {
            version: localSdkRuntime.version,
            sha256: localSdkRuntime.sha256,
          },
          sdkSource: localSdkRuntime.source,
          cdp,
          acceptanceProcess: {
            pid: preflightValue.prepared.process.pid,
            processStartedAt:
              preflightValue.prepared.process.processStartedAt,
            executablePath:
              preflightValue.prepared.process.executablePath,
            targetId: preflightValue.target.targetId,
          },
          authoringMain: null,
          signal,
        });
        if (!compatibility.ok || !compatibility.committed) {
          const sdkEvaluationBegan =
            compatibility.probe?.safety.hostSnapshots.preSdk !== null;
          return {
            ok: false,
            code: sdkEvaluationBegan
              ? "develop.sdk-contaminated"
              : compatibility.ok
                ? "compatibility.unproven"
                : compatibility.error.code,
            message: sdkEvaluationBegan
              ? "Local SDK compatibility evaluation did not complete cleanly."
              : compatibility.ok
                ? "Local SDK compatibility proof did not commit."
                : compatibility.error.message,
            failureKind: "sdk",
            sdkContamination: sdkEvaluationBegan,
            priorDistFingerprint: sdkBuilt.distFingerprintAfter,
            distFingerprintAfter: sdkBuilt.distFingerprintAfter,
            details: {
              status: compatibility.ok
                ? compatibility.probe.status
                : "failed",
              reason: compatibility.ok
                ? compatibility.probe.reason
                : compatibility.error.code,
            },
          };
        }
        preflightValue.localSdkSource = sdkBuilt.source;
        preflightValue.sdkRuntimeIdentity = {
          version: localSdkRuntime.version,
          sha256: localSdkRuntime.sha256,
        };
      }
      const built = await buildPluginWorkspace({
        workspacePath: preflight.workspacePath,
        timeoutMs: options.timeoutMs,
        signal,
        shouldCommit: () => signal?.aborted !== true,
        ...(localSdkRuntime === null
          ? {}
          : {
              sdkSourcePath: preflightValue!.localSdkSource!.rootPath,
              sdkInput: {
                kind: "local-source" as const,
                version: localSdkRuntime.version,
                runtimeSha256: localSdkRuntime.sha256,
                declarationsSha256:
                  localSdkRuntime.declarationsSha256,
              },
            }),
      });
      if (!built.ok) {
        return {
          ok: false,
          code: built.code,
          message: localSdkRuntime === null
            ? built.message
            : "Plugin build against the local SDK failed.",
          priorDistFingerprint: built.priorDistFingerprint,
          distFingerprintAfter: built.distFingerprintAfter,
          ...(localSdkRuntime === null && built.details !== undefined
            ? { details: built.details }
            : {}),
        };
      }
      return {
        ok: true,
        pluginIdentity: {
          id: built.report.id,
          version: built.report.version,
          payloadSha256: built.payloadSha256,
        },
        ...(localSdkRuntime === null
          ? {}
          : {
              sdkRuntimeIdentity: {
                version: localSdkRuntime.version,
                sha256: localSdkRuntime.sha256,
              },
            }),
      };
    },
    applyGeneration: async ({
      generation,
      preflight,
      pluginIdentity,
      sdkRuntimeIdentity,
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
        ...(preflightValue.localSdkSource === undefined
          ? {}
          : { sdkRuntime: sdkRuntimeIdentity }),
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
      const currentSdk = preflightValue.localSdkSource?.runtime ??
        await resolveSdkRuntimeIdentityForCli();
      if (
        currentSdk.version !== sdkRuntimeIdentity.version ||
        currentSdk.sha256 !== sdkRuntimeIdentity.sha256
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
        ...(preflightValue.localSdkSource === undefined
          ? {}
          : {
              sdkRuntimeOverride: {
                version: currentSdk.version,
                sha256: currentSdk.sha256,
                sourcePath:
                  preflightValue.localSdkSource.runtime.runtimePath,
              },
            }),
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
          sdkContamination:
            preflightValue.localSdkSource !== undefined &&
            result.sourceDelivered &&
            (
              requestedApplication?.error?.code ===
                "plugin.application.runtime-unusable" ||
              (
                requestedApplication?.stage === "evaluation" &&
                result.code.includes("evaluation")
              )
            ),
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
          sdkContamination:
            preflightValue.localSdkSource !== undefined &&
            result.sourceDelivered &&
            requestedApplication?.stage === "evaluation" &&
            requestedApplication.error?.code ===
              "plugin.application.runtime-unusable",
        };
      }
      return {
        ok: true,
        pluginIdentity,
        target: result.target,
      };
    },
    recoverSdkContamination: async ({ preflight, signal }) => {
      if (
        preflightValue === null ||
        preflightValue.localSdkSource === undefined
      ) {
        return {
          ok: false,
          code: "develop.sdk-recovery-unavailable",
          message:
            "SDK contamination recovery requires one validated local SDK source.",
        };
      }
      const sdkRuntime = {
        version: preflightValue.localSdkSource.runtime.version,
        sha256: preflightValue.localSdkSource.runtime.sha256,
      };
      const restarted = await runDevLifecycleOperation({
        kind: "restart",
        osHome: options.osHome,
        explodexHome: options.explodexHome,
        explicitRoot: options.explicitRoot,
        timeoutMs: options.timeoutMs,
        signal,
        hostAdapters,
        statusAdapters,
        cdp,
        requiredHost: preflightValue.prepared.host,
        sdkRuntime,
      });
      if (!restarted.ok) {
        return {
          ok: false,
          code: restarted.code,
          message: restarted.message,
          details: restarted.details,
        };
      }
      const prepared = await prepareOwnedDevTarget({
        operation: "develop",
        osHome: options.osHome,
        explodexHome: options.explodexHome,
        explicitRoot: options.explicitRoot,
        signal,
        hostAdapters,
        statusAdapters,
        cdp,
        sdkRuntime,
      });
      if (!prepared.ok) {
        return {
          ok: false,
          code: prepared.code,
          message: prepared.message,
          details: prepared.details,
        };
      }
      preflightValue.prepared = prepared.value;
      preflightValue.target = prepared.value.target;
      preflight.target = prepared.value.target;
      return { ok: true, target: prepared.value.target };
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
