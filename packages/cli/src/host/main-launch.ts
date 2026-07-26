/**
 * Explicit no-main one-shot main launch/attach path with atomic producer
 * coordination records, same-operation race-winner attach, reloaded
 * compatibility at the effect barrier, a single declarative evaluation,
 * exact partial-stage reporting, and process preservation.
 *
 * VAL-HOST-012 / VAL-HOST-013 / VAL-HOST-014 / VAL-HOST-015
 */

import { inspectCompatibleEndpoint } from "../cdp/endpoint.ts";
import { registerSessionOpeningGuard } from "../cdp/session-opening-guard.ts";
import type { SpawnedProcess } from "../dev/launch-adapters.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { acquireStageLock } from "../runtime/lock-stage.ts";
import {
  InterruptError,
  runBoundedOperation,
  TimeoutError,
} from "../runtime/operation.ts";
import type { BoundedOperationResult } from "../runtime/types.ts";
import { gateCompatibilityDependentOperation } from "./compatibility-gate.ts";
import { compatibilityKeysEqual } from "./compatibility-key.ts";
import {
  authorizeSameOperationAttach,
  captureNoMainLaunchBaseline,
  type SameOperationAuthority,
} from "./main-launch-authority.ts";
import {
  buildLaunchCoordinationRecord,
  consumeLaunchCoordinationEffect,
  loadLaunchCoordinationRecord,
  writeLaunchCoordinationRecord,
  type LaunchCoordinationRecord,
} from "./main-launch-coordination.ts";
import {
  errorMessage,
  freezeHostOrThrow,
  hostIdentityEqual,
  isLaunchFailure,
  launchFailure,
  loadCurrentCompatibility,
  mapCoordinationFailure,
  mapRevalidationReason,
  mapTargetCode,
  markLaunchStage,
  normalizeLaunchResult,
  readLaunchStages,
  registerProtectedChatGpt,
  setSurviving,
  summarizeHost,
  summarizeProcess,
  waitForMainPortOwnership,
} from "./main-launch-helpers.ts";
import {
  buildMainLaunchCompatibilityKey,
  requireMainLaunchRevalidation,
} from "./main-launch-revalidate.ts";
import {
  buildMainLaunchArgv,
  formatMainLaunchHuman,
  formatMainLaunchJson,
  MAIN_CDP_HOST,
  MAIN_CDP_PORT,
  resolveDeclarativeEffect,
  type LaunchedMainIdentity,
  type MainLaunchOptions,
  type MainLaunchSuccess,
} from "./main-launch-types.ts";
import {
  MAIN_HOT_PATH_RECOVERY_GUIDANCE,
  MAIN_HOT_PATH_UNAVAILABLE_CODE,
  assessMainHotPath,
} from "./main-hot-path.ts";
import {
  collectHostStatus,
  roleEndpoint,
  type VerifiedProcess,
} from "./status.ts";
import type { ProbeIdentity } from "./types.ts";
import { DEFAULT_PROBE_TOOL_VERSION, PROBE_SCHEMA_VERSION } from "./constants.ts";

export {
  buildMainLaunchArgv,
  formatMainLaunchHuman,
  formatMainLaunchJson,
  MAIN_CDP_HOST,
  MAIN_CDP_PORT,
  resolveDeclarativeEffect,
} from "./main-launch-types.ts";
export type {
  LaunchedMainIdentity,
  MainLaunchDeclarativeEffect,
  MainLaunchErrorCode,
  MainLaunchFailureDetails,
  MainLaunchOptions,
  MainLaunchPath,
  MainLaunchStage,
  MainLaunchSuccess,
} from "./main-launch-types.ts";
export {
  authorizeSameOperationAttach,
  captureNoMainLaunchBaseline,
  isSameOperationRaceWinner,
  processKey,
} from "./main-launch-authority.ts";
export type {
  MainLaunchBaseline,
  SameOperationAuthority,
} from "./main-launch-authority.ts";
export {
  buildLaunchCoordinationRecord,
  consumeLaunchCoordinationEffect,
  loadLaunchCoordinationRecord,
  parseLaunchCoordinationRecord,
  validateLaunchCoordinationRecord,
  writeLaunchCoordinationRecord,
} from "./main-launch-coordination.ts";
export type {
  LaunchCoordinationRecord,
} from "./main-launch-coordination.ts";

function resolveProbe(probe: ProbeIdentity | undefined): ProbeIdentity {
  return probe ?? {
    schemaVersion: PROBE_SCHEMA_VERSION,
    toolVersion: DEFAULT_PROBE_TOOL_VERSION,
  };
}

/**
 * Explicit normal launch from no-main with free 9333, or freshly verified
 * same-operation race-winner attach bound to a producer coordination record.
 * Initially present cdp-main is refused. Never shadows or mutates a plain/
 * user-owned main.
 */
export async function runExplicitMainLaunch(
  options: MainLaunchOptions,
): Promise<BoundedOperationResult<MainLaunchSuccess>> {
  const explodexHome = resolveExplodexHome({
    explodexHome: options.explodexHome,
    osHome: options.osHome,
  });
  const endpoint = roleEndpoint("main");
  const signalsSent: Array<{ pid: number; signal: string }> = [];
  const probe = resolveProbe(options.probe);
  const declarativeEffect = resolveDeclarativeEffect(options.effect);

  return runBoundedOperation({
    adapters: options.runtime,
    operation: "launch-with-injection",
    operationId: options.operationId,
    stageBounds: options.stageBounds,
    run: async (ctx) => {
      // ── Preflight ──────────────────────────────────────────────────────
      const frozenHost = options.freezeHost !== undefined
        ? await options.freezeHost()
        : await freezeHostOrThrow(options.hostAdapters);
      ctx.markStageComplete("preflight");
      markLaunchStage(ctx, "preflight");

      const compatibility = options.loadCompatibility !== undefined
        ? await options.loadCompatibility()
        : await loadCurrentCompatibility({
            hostAdapters: options.hostAdapters,
            host: frozenHost,
            explodexHome,
            sdkRuntime: options.sdkRuntime,
            probe: options.probe,
          });

      const gate = gateCompatibilityDependentOperation({
        operation: "launch-with-injection",
        compatibility,
      });
      if (!gate.allowed) {
        throw launchFailure({
          code: gate.error.code,
          message: gate.error.message,
          path: "refused",
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
          details: {
            nextAction: gate.error.nextAction,
            compatibility: gate.compatibility,
          },
        });
      }

      const frozenCompatibilityKey = buildMainLaunchCompatibilityKey({
        host: frozenHost,
        sdkRuntime: options.sdkRuntime,
        probe,
      });
      if (
        compatibility.key === null ||
        !compatibilityKeysEqual(compatibility.key, frozenCompatibilityKey)
      ) {
        throw launchFailure({
          code: "compatibility_stale",
          message: "Compatibility key does not match the frozen host/runtime identity.",
          path: "refused",
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
          details: {
            frozenKey: frozenCompatibilityKey,
            compatibility,
          },
        });
      }

      const initialStatus = options.collectStatus !== undefined
        ? await options.collectStatus()
        : await collectHostStatus({
            role: "main",
            adapters: options.statusAdapters,
          });

      const hot = assessMainHotPath({
        operation: "launch-with-injection",
        mainState: initialStatus.mainState,
        endpointObstruction: initialStatus.endpointObstruction,
        compatibility,
      });

      if (initialStatus.mainState === "plain-main") {
        throw launchFailure({
          code: MAIN_HOT_PATH_UNAVAILABLE_CODE,
          message: hot.allowed
            ? "Plain authoring main cannot be launched or shadowed."
            : hot.message,
          path: "refused",
          mainState: "plain-main",
          endpointObstruction: initialStatus.endpointObstruction,
          recoveryGuidance: MAIN_HOT_PATH_RECOVERY_GUIDANCE,
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
          details: {
            processes: initialStatus.processes.map(summarizeProcess),
          },
        });
      }

      if (initialStatus.mainState === "ambiguous-main") {
        throw launchFailure({
          code: "state_changed",
          message: "Main process/renderer state is ambiguous; refusing launch and attach.",
          path: "refused",
          mainState: "ambiguous-main",
          endpointObstruction: initialStatus.endpointObstruction,
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
          details: { diagnostic: initialStatus.diagnostic },
        });
      }

      // Initially observed cdp-main is availability only — no attach/evaluation.
      if (initialStatus.mainState === "cdp-main") {
        throw launchFailure({
          code: "preexisting_cdp_main",
          message:
            "Initially observed cdp-main is availability only and grants no attach or evaluation authority. Explicit no-main launch/attach requires beginning from exact no-main with free 9333.",
          path: "refused",
          mainState: "cdp-main",
          endpointObstruction: initialStatus.endpointObstruction,
          recoveryGuidance: MAIN_HOT_PATH_RECOVERY_GUIDANCE,
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
          details: {
            processes: initialStatus.processes.map(summarizeProcess),
            selectedTarget: initialStatus.selectedTarget,
          },
        });
      }

      if (
        initialStatus.mainState === "no-main" &&
        initialStatus.endpointObstruction === "foreign-or-mismatched-endpoint"
      ) {
        throw launchFailure({
          code: "port_obstructed",
          message: "Port 9333 is occupied by a foreign or mismatched listener; launch is blocked.",
          path: "refused",
          mainState: "no-main",
          endpointObstruction: "foreign-or-mismatched-endpoint",
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
          details: { listeners: initialStatus.listeners },
        });
      }

      if (
        initialStatus.mainState !== "no-main" ||
        initialStatus.endpointObstruction !== "port-free"
      ) {
        throw launchFailure({
          code: "state_changed",
          message:
            `Explicit launch requires exact no-main with free 9333 at operation start; observed mainState=${initialStatus.mainState} obstruction=${initialStatus.endpointObstruction}`,
          path: "refused",
          mainState: initialStatus.mainState,
          endpointObstruction: initialStatus.endpointObstruction,
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
        });
      }

      const baseline = captureNoMainLaunchBaseline({
        operationId: ctx.identity.operationId,
        status: initialStatus,
      });
      if (baseline === null) {
        throw launchFailure({
          code: "state_changed",
          message: "Failed to capture exact no-main/free-9333 launch baseline.",
          path: "refused",
          mainState: initialStatus.mainState,
          endpointObstruction: initialStatus.endpointObstruction,
          lastCompletedStage: "preflight",
          stalledStage: "preflight",
        });
      }

      let path: "spawn" | "attach" = "spawn";
      let boundProcess: VerifiedProcess | null = null;
      let spawned: SpawnedProcess | null = null;
      let spawnedByThisOperation = false;
      let surviving: LaunchedMainIdentity | null = null;
      let authority: SameOperationAuthority | null = null;
      let coordination: LaunchCoordinationRecord | null = null;

      // ── Launch coordination lock ───────────────────────────────────────
      const lock = await acquireStageLock(ctx, {
        explodexHome,
        resource: "main-launch",
        label: "main-launch",
      });
      ctx.markStageComplete("lock-acquisition");
      markLaunchStage(ctx, "lock-acquisition");
      const holdsLaunchCoordination = true;
      const lockGeneration = lock.record.generation;

      try {
        // ── Pre-spawn recheck ────────────────────────────────────────────
        const recheck = options.collectStatus !== undefined
          ? await options.collectStatus()
          : await collectHostStatus({
              role: "main",
              adapters: options.statusAdapters,
            });
        ctx.markStageComplete("local-work");
        markLaunchStage(ctx, "pre-spawn-recheck");

        const recheckedHost = options.freezeHost !== undefined
          ? await options.freezeHost()
          : await freezeHostOrThrow(options.hostAdapters);
        if (!hostIdentityEqual(frozenHost, recheckedHost)) {
          throw launchFailure({
            code: "host_identity_drift",
            message: "Canonical host identity drifted before spawn; aborting without reconnect.",
            path: "failed",
            lastCompletedStage: "pre-spawn-recheck",
            stalledStage: "spawn",
            details: {
              frozen: summarizeHost(frozenHost),
              current: summarizeHost(recheckedHost),
            },
          });
        }

        if (recheck.mainState === "plain-main") {
          throw launchFailure({
            code: "state_changed",
            message:
              "A plain authoring main appeared before spawn. Explodex will not shadow or debug-enable it.",
            path: "refused",
            mainState: "plain-main",
            endpointObstruction: recheck.endpointObstruction,
            recoveryGuidance: MAIN_HOT_PATH_RECOVERY_GUIDANCE,
            lastCompletedStage: "pre-spawn-recheck",
            stalledStage: "spawn",
            details: { processes: recheck.processes.map(summarizeProcess) },
          });
        }

        if (recheck.mainState === "ambiguous-main") {
          throw launchFailure({
            code: "state_changed",
            message: "Main process/renderer state became ambiguous before spawn.",
            path: "refused",
            mainState: "ambiguous-main",
            endpointObstruction: recheck.endpointObstruction,
            lastCompletedStage: "pre-spawn-recheck",
            stalledStage: "spawn",
            details: { diagnostic: recheck.diagnostic },
          });
        }

        if (
          recheck.mainState === "no-main" &&
          recheck.endpointObstruction === "foreign-or-mismatched-endpoint"
        ) {
          throw launchFailure({
            code: "state_changed",
            message: "Port 9333 became obstructed before spawn; launch aborted without creating a process.",
            path: "failed",
            mainState: "no-main",
            endpointObstruction: "foreign-or-mismatched-endpoint",
            lastCompletedStage: "pre-spawn-recheck",
            stalledStage: "spawn",
            details: { listeners: recheck.listeners },
          });
        }

        if (recheck.mainState === "cdp-main") {
          // Same-operation race-winner attach only via exact producer record.
          path = "attach";
          const process = recheck.processes[0];
          if (process === undefined || recheck.selectedTarget === null) {
            throw launchFailure({
              code: "state_changed",
              message: "cdp-main was reported without exact process/target identity.",
              path: "failed",
              mainState: "cdp-main",
              lastCompletedStage: "pre-spawn-recheck",
              stalledStage: "cdp-discovery",
            });
          }

          const existingRecord = await loadLaunchCoordinationRecord({
            adapters: options.hostAdapters,
            explodexHome,
          });
          const attachAuth = authorizeSameOperationAttach({
            baseline,
            holdsLaunchCoordination,
            candidate: process,
            selectedTargetPresent: recheck.selectedTarget !== null,
            coordination: existingRecord,
            frozenHost,
            compatibilityKey: frozenCompatibilityKey,
            requireUnconsumedEffect: true,
          });
          if (!attachAuth.ok) {
            const code = attachAuth.reason === "not_same_operation_winner" ||
                attachAuth.reason === "missing_record" ||
                attachAuth.reason === "missing"
              ? attachAuth.reason === "not_same_operation_winner"
                ? "preexisting_cdp_main"
                : "coordination_record_missing"
              : mapCoordinationFailure(attachAuth.reason);
            throw launchFailure({
              code,
              message:
                "Attach refused: winner is not bound by an exact unconsumed producer coordination record under launch coordination from a no-main/free-9333 baseline.",
              path: "refused",
              mainState: "cdp-main",
              endpointObstruction: recheck.endpointObstruction,
              lastCompletedStage: "pre-spawn-recheck",
              stalledStage: "spawn",
              details: {
                reason: attachAuth.reason,
                baseline,
                candidate: summarizeProcess(process),
                coordinationPresent: existingRecord !== null,
              },
            });
          }
          authority = attachAuth.authority;
          coordination = attachAuth.authority.coordination;
          boundProcess = process;
          surviving = {
            pid: process.pid,
            processStartedAt: process.processStartedAt,
            executablePath: process.executablePath,
            port: MAIN_CDP_PORT,
            host: MAIN_CDP_HOST,
          };
          setSurviving(ctx, surviving);
        } else if (
          recheck.mainState === "no-main" &&
          recheck.endpointObstruction === "port-free"
        ) {
          path = "spawn";
        } else {
          throw launchFailure({
            code: "state_changed",
            message: `Unexpected pre-spawn state mainState=${recheck.mainState} obstruction=${recheck.endpointObstruction}`,
            path: "failed",
            mainState: recheck.mainState,
            endpointObstruction: recheck.endpointObstruction,
            lastCompletedStage: "pre-spawn-recheck",
            stalledStage: "spawn",
          });
        }

        // ── Spawn (only from no-main + free) ─────────────────────────────
        if (path === "spawn") {
          try {
            spawned = await options.spawn.spawn({
              executablePath: frozenHost.executablePath,
              argv: buildMainLaunchArgv(),
              env: {},
              inheritHostEnvironment: true,
            });
          } catch (error: unknown) {
            throw launchFailure({
              code: "launch_failed",
              message: error instanceof Error ? error.message : "Failed to spawn ChatGPT main",
              path: "failed",
              lastCompletedStage: "pre-spawn-recheck",
              stalledStage: "spawn",
              details: { cause: errorMessage(error) },
            });
          }
          spawnedByThisOperation = true;
          markLaunchStage(ctx, "spawn");

          // Identify the exact launched process. Never signal it on failure.
          const identity = await options.runtime.process.identify(spawned.pid);
          if (identity === null || identity.pid !== spawned.pid) {
            surviving = {
              pid: spawned.pid,
              processStartedAt: "unresolved",
              executablePath: frozenHost.executablePath,
              port: MAIN_CDP_PORT,
              host: MAIN_CDP_HOST,
            };
            setSurviving(ctx, surviving);
            registerProtectedChatGpt(ctx, surviving, signalsSent);
            throw launchFailure({
              code: "launch_failed",
              message: "Launched process identity could not be resolved after spawn.",
              path: "failed",
              survivingChatGpt: surviving,
              lastCompletedStage: "spawn",
              stalledStage: "launch-readiness",
            });
          }

          surviving = {
            pid: spawned.pid,
            processStartedAt: identity.processStartedAt,
            executablePath: frozenHost.executablePath,
            port: MAIN_CDP_PORT,
            host: MAIN_CDP_HOST,
          };
          boundProcess = {
            pid: spawned.pid,
            parentPid: 0,
            executablePath: frozenHost.executablePath,
            arguments: [frozenHost.executablePath, ...buildMainLaunchArgv()],
            processStartedAt: identity.processStartedAt,
          };
          setSurviving(ctx, surviving);
          registerProtectedChatGpt(ctx, surviving, signalsSent);
        }

        if (boundProcess === null || surviving === null) {
          throw launchFailure({
            code: "operation_failed",
            message: "Internal error: process binding missing after spawn/attach decision",
            path: "failed",
            lastCompletedStage: "pre-spawn-recheck",
            stalledStage: "launch-readiness",
          });
        }

        // ── Launch readiness ─────────────────────────────────────────────
        const readyProcess = await ctx.runExternalWait("launch-readiness", async (ctl) => {
          if (surviving === null) {
            throw launchFailure({
              code: "readiness_failed",
              message: "Missing surviving process during readiness",
              path: "failed",
              lastCompletedStage: "spawn",
              stalledStage: "launch-readiness",
            });
          }
          return waitForMainPortOwnership({
            runtime: options.runtime,
            surviving,
            path,
            pollMs: options.readinessPollMs ?? 50,
            deadlineMs: options.runtime.clock.nowMs() + ctl.remainingMs(),
            signal: ctl.signal,
            throwIfInterrupted: () => ctl.throwIfInterrupted(),
            tryCommitEffect: () => ctl.tryCommitEffect(),
            collectStatus: async (signal) =>
              options.collectStatus !== undefined
                ? options.collectStatus(signal)
                : collectHostStatus({
                    role: "main",
                    adapters: options.statusAdapters,
                    signal,
                  }),
            onInterrupt: () => {
              throw new InterruptError("launch-readiness");
            },
          });
        });
        ctx.markStageComplete("launch-readiness");
        markLaunchStage(ctx, "launch-readiness");
        boundProcess = readyProcess;
        surviving = {
          pid: readyProcess.pid,
          processStartedAt: readyProcess.processStartedAt,
          executablePath: readyProcess.executablePath,
          port: MAIN_CDP_PORT,
          host: MAIN_CDP_HOST,
        };
        setSurviving(ctx, surviving);

        // Host revalidation before CDP attach/evaluation
        const hostBeforeCdp = options.freezeHost !== undefined
          ? await options.freezeHost()
          : await freezeHostOrThrow(options.hostAdapters);
        if (!hostIdentityEqual(frozenHost, hostBeforeCdp)) {
          throw launchFailure({
            code: "host_identity_drift",
            message: "Canonical host identity drifted after spawn; preserving process without reconnect.",
            path: "failed",
            survivingChatGpt: surviving,
            lastCompletedStage: "launch-readiness",
            stalledStage: "cdp-discovery",
          });
        }

        // ── CDP discovery ────────────────────────────────────────────────
        const sessionGuard = registerSessionOpeningGuard(ctx.scope, {
          label: `cdp-open:main:${ctx.identity.operationId}`,
        });
        const discovery = await ctx.runExternalWait("cdp-discovery", async (ctl) => {
          try {
            const inspected = await inspectCompatibleEndpoint({
              role: "main",
              endpoint,
              process: boundProcess!,
              host: frozenHost,
              cdp: options.cdp,
              signal: ctl.signal,
              retainSession: true,
              onSessionOpened(session) {
                sessionGuard.adopt(session);
              },
            });
            if (inspected.kind !== "available") {
              if (!sessionGuard.hasAdoptedSession()) sessionGuard.releaseWithoutSession();
              const code = inspected.kind === "identity-mismatch"
                ? "endpoint_identity_mismatch"
                : mapTargetCode(inspected.code);
              throw launchFailure({
                code,
                message: `Exact renderer selection failed after launch: ${code}`,
                path: "failed",
                survivingChatGpt: surviving ?? undefined,
                lastCompletedStage: "launch-readiness",
                stalledStage: "cdp-discovery",
                details: { inspection: inspected },
              });
            }
            if (inspected.session === undefined) {
              if (!sessionGuard.hasAdoptedSession()) sessionGuard.releaseWithoutSession();
              throw launchFailure({
                code: "target_not_found",
                message: "Selected target session was unavailable",
                path: "failed",
                survivingChatGpt: surviving ?? undefined,
                lastCompletedStage: "launch-readiness",
                stalledStage: "cdp-discovery",
              });
            }
            sessionGuard.adopt(inspected.session);
            if (!ctl.tryCommitEffect()) {
              throw new InterruptError("cdp-discovery");
            }
            return { target: inspected.target, session: inspected.session };
          } catch (error: unknown) {
            if (isLaunchFailure(error) || error instanceof InterruptError || error instanceof TimeoutError) {
              throw error;
            }
            throw launchFailure({
              code: "operation_failed",
              message: error instanceof Error ? error.message : "CDP discovery failed",
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "launch-readiness",
              stalledStage: "cdp-discovery",
              details: { cause: errorMessage(error) },
            });
          }
        });
        ctx.markStageComplete("cdp-discovery");
        markLaunchStage(ctx, "cdp-discovery");

        // ── Atomic producer coordination record ──────────────────────────
        if (path === "spawn") {
          coordination = buildLaunchCoordinationRecord({
            producerOperationId: ctx.identity.operationId,
            lockGeneration,
            writtenAt: options.runtime.clock.nowIso(),
            frozenHost,
            compatibilityKey: frozenCompatibilityKey,
            process: boundProcess,
            browserIdentity: discovery.target.browserIdentity,
            target: discovery.target,
          });
          await writeLaunchCoordinationRecord({
            adapters: options.hostAdapters,
            explodexHome,
            record: coordination,
          });
          authority = {
            kind: "spawned-by-this-operation",
            process: boundProcess,
            operationId: ctx.identity.operationId,
            lockGeneration,
            coordination,
          };
          markLaunchStage(ctx, "coordination-record");
        } else {
          // Attach path: revalidate record against discovered identity.
          if (coordination === null || authority === null) {
            throw launchFailure({
              code: "coordination_record_missing",
              message: "Attach path missing producer coordination record after discovery.",
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "cdp-discovery",
              stalledStage: "coordination-record",
            });
          }
          if (
            coordination.process.pid !== boundProcess.pid ||
            coordination.process.processStartedAt !== boundProcess.processStartedAt ||
            coordination.target.targetId !== discovery.target.targetId ||
            coordination.target.executionContextId !== discovery.target.executionContextId ||
            coordination.target.executionContextUniqueId !==
              discovery.target.executionContextUniqueId ||
            coordination.browserIdentity !== discovery.target.browserIdentity
          ) {
            throw launchFailure({
              code: "coordination_record_invalid",
              message:
                "Discovered identity does not exactly match the producer coordination record; refusing evaluation.",
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "cdp-discovery",
              stalledStage: "coordination-record",
              details: {
                recordProcess: coordination.process,
                boundProcess: summarizeProcess(boundProcess),
                recordTarget: coordination.target,
                discoveredTarget: discovery.target,
              },
            });
          }
          authority = {
            ...authority,
            process: boundProcess,
            coordination,
          };
          markLaunchStage(ctx, "coordination-record");
        }

        if (authority === null || coordination === null) {
          throw launchFailure({
            code: "operation_failed",
            message: "Internal error: same-operation authority or coordination missing",
            path: "failed",
            survivingChatGpt: surviving ?? undefined,
            lastCompletedStage: "cdp-discovery",
            stalledStage: "compatibility-barrier",
          });
        }

        const collectStatus = async (signal?: AbortSignal) =>
          options.collectStatus !== undefined
            ? options.collectStatus(signal)
            : collectHostStatus({
                role: "main",
                adapters: options.statusAdapters,
                signal,
              });

        const freezeHost = async () =>
          options.freezeHost !== undefined
            ? options.freezeHost()
            : freezeHostOrThrow(options.hostAdapters);

        const failRevalidation = (
          reason: string,
          observation: unknown,
          survivingProcess: LaunchedMainIdentity | undefined,
          stalledStage: "compatibility-barrier" | "effect-consume" | "requested-work" =
            "compatibility-barrier",
        ): never => {
          throw launchFailure({
            code: mapRevalidationReason(reason),
            message:
              `Pre-effect revalidation failed (${reason}); stopping without reconnect and preserving any operation-launched process.`,
            path: "failed",
            survivingChatGpt: survivingProcess,
            lastCompletedStage: "coordination-record",
            stalledStage,
            details: { reason, observation },
          });
        };

        // ── Effect barrier: reload compatibility, revalidate, consume, evaluate once ──
        const evaluation = await ctx.runExternalWait("cdp-evaluation", async (ctl) => {
          ctl.throwIfInterrupted();

          // Immediately before the sole declarative evaluation, reload and gate
          // persisted compatibility; require exact equality with the frozen key.
          const reloadedCompatibility = options.reloadCompatibility !== undefined
            ? await options.reloadCompatibility()
            : options.loadCompatibility !== undefined
              ? await options.loadCompatibility()
              : await loadCurrentCompatibility({
                  hostAdapters: options.hostAdapters,
                  host: frozenHost,
                  explodexHome,
                  sdkRuntime: options.sdkRuntime,
                  probe: options.probe,
                });

          const reloadedGate = gateCompatibilityDependentOperation({
            operation: "launch-with-injection",
            compatibility: reloadedCompatibility,
          });
          if (!reloadedGate.allowed) {
            throw launchFailure({
              code: reloadedGate.error.code,
              message:
                `Persisted compatibility failed at the effect barrier: ${reloadedGate.error.message}`,
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "coordination-record",
              stalledStage: "compatibility-barrier",
              details: {
                nextAction: reloadedGate.error.nextAction,
                compatibility: reloadedGate.compatibility,
              },
            });
          }
          if (
            reloadedCompatibility.key === null ||
            !compatibilityKeysEqual(reloadedCompatibility.key, frozenCompatibilityKey) ||
            !compatibilityKeysEqual(
              reloadedCompatibility.key,
              coordination!.compatibilityKey,
            )
          ) {
            throw launchFailure({
              code: "compatibility_identity_drift",
              message:
                "Reloaded persisted compatibility key does not exactly equal the frozen coordination key.",
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "coordination-record",
              stalledStage: "compatibility-barrier",
              details: {
                frozenKey: frozenCompatibilityKey,
                recordKey: coordination!.compatibilityKey,
                reloadedKey: reloadedCompatibility.key,
              },
            });
          }
          markLaunchStage(ctx, "compatibility-barrier");

          await requireMainLaunchRevalidation({
            freezeHost,
            collectStatus,
            runtimeProcess: options.runtime.process,
            cdp: options.cdp,
            session: discovery.session,
            expected: {
              host: frozenHost,
              process: boundProcess!,
              target: discovery.target,
              compatibilityKey: frozenCompatibilityKey,
              sdkRuntime: options.sdkRuntime,
              probe,
              authority: authority!,
              coordination: coordination!,
              reloadedCompatibility,
            },
            signal: ctl.signal,
            onFailure: (reason, observation) =>
              failRevalidation(reason, observation, surviving ?? undefined),
          });

          // Atomically consume one-shot effect authority before evaluation.
          const consumed = await consumeLaunchCoordinationEffect({
            adapters: options.hostAdapters,
            explodexHome,
            expected: coordination!,
            consumerOperationId: ctx.identity.operationId,
            nowIso: options.runtime.clock.nowIso(),
          });
          if (!consumed.ok) {
            throw launchFailure({
              code: mapCoordinationFailure(consumed.reason),
              message:
                `One-shot effect authority could not be consumed (${consumed.reason}); stopping before evaluation.`,
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "compatibility-barrier",
              stalledStage: "effect-consume",
              details: { reason: consumed.reason },
            });
          }
          coordination = consumed.record;
          authority = {
            ...authority!,
            coordination: consumed.record,
          };
          markLaunchStage(ctx, "effect-consume");

          if (!ctl.tryCommitEffect()) {
            throw new InterruptError("cdp-evaluation");
          }

          try {
            const result = await discovery.session.evaluate({
              executionContextId: discovery.target.executionContextId,
              executionContextUniqueId: discovery.target.executionContextUniqueId,
              expression: declarativeEffect.expression,
              signal: ctl.signal,
            });
            return result;
          } catch (error: unknown) {
            if (isLaunchFailure(error) || error instanceof InterruptError || error instanceof TimeoutError) {
              throw error;
            }
            throw launchFailure({
              code: "requested_work_failed",
              message: error instanceof Error ? error.message : "Declarative evaluation failed",
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "effect-consume",
              stalledStage: "requested-work",
              details: { cause: errorMessage(error) },
            });
          }
        });
        ctx.markStageComplete("cdp-evaluation");
        markLaunchStage(ctx, "requested-work");

        const stagesCompleted = readLaunchStages(ctx);
        return {
          path,
          host: frozenHost,
          process: surviving,
          target: discovery.target,
          work: evaluation.value,
          stagesCompleted,
          spawnedByThisOperation,
          chatgptSurvives: true as const,
          injectionClaimed: false,
          effect: {
            kind: "evaluate-expression",
            expression: declarativeEffect.expression,
            evaluation,
          },
        } satisfies MainLaunchSuccess;
      } finally {
        // Lock is released via scope dispose. Never signal protected ChatGPT.
        // Do not mark cleanup here — ResourceScope disposal owns cleanup and
        // must not be claimed before residual disposal completes.
        void lock;
        void signalsSent;
        void baseline;
      }
    },
  }).then((result) => normalizeLaunchResult(result));
}
