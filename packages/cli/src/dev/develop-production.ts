import { watch, type FSWatcher } from "node:fs";
import { relative, sep } from "node:path";
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

function createWatcher(options: {
  preflight: ProductionDevelopPreflightSuccess;
  onStop: () => void;
}): DevelopOwnedResource {
  const watcher = watch(
    options.preflight.workspacePath,
    { recursive: true, persistent: true },
    (_eventType, fileName) => {
      if (fileName === null) return;
      const changed = `${options.preflight.workspacePath}/${fileName}`;
      if (
        options.preflight.excludedPaths.some((path) => isWithin(path, changed))
      ) {
        return;
      }
      // M4-F05 owns generation coalescing and rebuild. This leaf establishes
      // the bounded foreground watcher without applying later edits.
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
    openWatcher: async ({ onStop }) => {
      if (preflightValue === null) {
        throw new Error("Develop watcher opened before successful preflight.");
      }
      return createWatcher({ preflight: preflightValue, onStop });
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
    applyInitial: async ({ preflight, signal }) => {
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
        operationId: `develop-apply-${Date.now()}`,
        hostAdapters,
        statusAdapters,
        cdp,
      });
      if (!result.ok) {
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
          details: result.details,
        };
      }
      return {
        ok: true,
        pluginIdentity: {
          id: result.identity.id,
          version: result.identity.version,
          payloadSha256: result.identity.payloadSha256,
        },
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
