import { resolve } from "node:path";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure } from "../cli/errors.ts";
import { stopExactProcess } from "../dev/phase0-operation.ts";
import {
  inspectDevInstanceStatus,
  recoverDevInstanceFromSystem,
} from "../dev/status-operation.ts";
import type { DevTerminationResult } from "../dev/workflow.ts";
import {
  createNodeReadOnlyCommandRunner,
} from "../host/process-adapters.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  createDefaultRuntimeAdapters,
} from "../runtime/adapters.ts";
import { successEnvelope, type RenderedCliResult } from "../output/envelope.ts";

const OPERATION = "dev.recover";

export async function runDevRecover(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const osHome = options.env.HOME;
  if (osHome === undefined || osHome.length === 0) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: "HOME is required to resolve the isolated development instance.",
    });
  }
  let explodexHome: string;
  try {
    explodexHome = resolve(resolveExplodexHome({
      osHome,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    }));
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }

  const runtime = await createDefaultRuntimeAdapters();
  const commands = createNodeReadOnlyCommandRunner();
  const cdp = createNodeCdpAdapter();
  const result = await recoverDevInstanceFromSystem({
    osHome,
    explodexHome,
    explicitRoot:
      options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
    waitBoundMs: Math.min(options.globals.timeoutMs, 2_000),
    signal: options.signal,
    runtimeAdapters: runtime,
    terminate: async (snapshot): Promise<DevTerminationResult> => {
      const refreshed = await inspectDevInstanceStatus({
        osHome,
        explodexHome,
        explicitRoot:
          options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
        operation: "recover",
        signal: options.signal,
      });
      if (
        refreshed.assessment.recoveryEligibility !== "fully-owned-live" ||
        refreshed.state?.pid !== snapshot.state?.pid ||
        refreshed.state?.processStartedAt !==
          snapshot.state?.processStartedAt ||
        refreshed.state?.targetId !== snapshot.state?.targetId ||
        refreshed.state?.executionContextUniqueId !==
          snapshot.state?.executionContextUniqueId
      ) {
        return {
          ok: false,
          confirmedExit: false,
          code: "dev.ownership-uncertain",
          message:
            "Exact development ownership changed immediately before recovery termination.",
          method: null,
        };
      }
      const state = refreshed.state;
      if (
        state === null ||
        state.pid === null ||
        state.processStartedAt === null ||
        state.targetId === null ||
        state.executionContextUniqueId === null
      ) {
        return {
          ok: false,
          confirmedExit: false,
          code: "dev.ownership-uncertain",
          message: "Recovery termination requires complete exact live identity.",
          method: null,
        };
      }
      const stopped = await stopExactProcess({
        runtimeProcess: runtime.process,
        commands,
        cdp,
        pid: state.pid,
        processStartedAt: state.processStartedAt,
        executablePath: state.executablePath,
        marker: state.launchMarker,
        timeoutMs: options.globals.timeoutMs,
        pollMs: 100,
        expectedTargetId: state.targetId,
        expectedContextUniqueId: state.executionContextUniqueId,
        requireCompleteEndpointOwnershipForSignal: true,
        beforeExactSignal: async () => {
          const finalSnapshot = await inspectDevInstanceStatus({
            osHome,
            explodexHome,
            explicitRoot:
              options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
            operation: "recover",
            signal: undefined,
          });
          const finalState = finalSnapshot.state;
          if (
            finalSnapshot.assessment.recoveryEligibility !==
              "fully-owned-live" ||
            finalState === null ||
            finalState.rootPath !== state.rootPath ||
            finalState.pid !== state.pid ||
            finalState.processStartedAt !== state.processStartedAt ||
            finalState.targetId !== state.targetId ||
            finalState.executionContextUniqueId !==
              state.executionContextUniqueId ||
            finalState.appBuild !== state.appBuild ||
            JSON.stringify(finalState.frozenHost) !==
              JSON.stringify(state.frozenHost)
          ) {
            return {
              ok: false as const,
              reason:
                "Complete development ownership drifted before recovery SIGTERM.",
            };
          }
          return { ok: true as const };
        },
        privateRoots: [
          state.electronUserDataPath,
          state.codexHomePath,
          state.explodexStatePath,
        ],
        signal: options.signal,
      });
      if (
        stopped.stopped &&
        stopped.portReleased &&
        !stopped.uncertain &&
        stopped.method !== "none"
      ) {
        return {
          ok: true,
          confirmedExit: true,
          method: stopped.method,
        };
      }
      return {
        ok: false,
        confirmedExit: false,
        code: stopped.code ??
          (stopped.uncertain
            ? "dev.ownership-uncertain"
            : stopped.stopped
              ? "dev.recovery-failed"
              : "operation.timeout"),
        message:
          stopped.reason ??
          "Exact development process did not terminate and release 9444.",
        method: stopped.method === "none" ? null : stopped.method,
        elapsedMs: stopped.elapsedMs,
        boundMs: stopped.boundMs,
        details: {
          residualDisposition: stopped.residualDisposition ?? "unknown",
          portReleased: stopped.portReleased,
          uncertain: stopped.uncertain,
        },
      };
    },
  });

  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: result.details,
    });
  }
  return {
    envelope: successEnvelope(OPERATION, {
      operationId: result.operationId,
      rootPath: result.previous.rootPath,
      previousStatus: result.previous.assessment.observedStatus,
      status: result.state.status,
      disposition: result.disposition,
      terminationMethod: result.terminationMethod,
      state: result.state,
      activity: {
        launched: false,
        evaluated: false,
        fellBack: false,
      },
    }),
    exitCode: 0,
    humanStdout: [
      "Explodex development recovery",
      `root: ${result.previous.rootPath}`,
      `previousStatus: ${result.previous.assessment.observedStatus}`,
      `status: ${result.state.status}`,
      `disposition: ${result.disposition}`,
      `terminationMethod: ${result.terminationMethod ?? "none"}`,
      "",
    ].join("\n"),
    humanStderr: "",
  };
}
