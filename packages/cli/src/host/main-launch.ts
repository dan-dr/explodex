/**
 * Explicit no-main one-shot main launch/attach path with bounded launch
 * coordination, race handling, partial-stage reporting, and process preservation.
 *
 * VAL-HOST-012 / VAL-HOST-013 / VAL-HOST-014 / VAL-HOST-015
 */

import { inspectCompatibleEndpoint } from "../cdp/endpoint.ts";
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
import {
  errorMessage,
  freezeHostOrThrow,
  hostIdentityEqual,
  isLaunchFailure,
  launchFailure,
  loadCurrentCompatibility,
  mapTargetCode,
  markLaunchStage,
  normalizeLaunchResult,
  readLaunchStages,
  registerProtectedChatGpt,
  setSurviving,
  sleep,
  summarizeHost,
  summarizeProcess,
} from "./main-launch-helpers.ts";
import {
  buildMainLaunchArgv,
  DEFAULT_BENIGN_MAIN_EXPRESSION,
  formatMainLaunchHuman,
  formatMainLaunchJson,
  MAIN_CDP_HOST,
  MAIN_CDP_PORT,
  type LaunchedMainIdentity,
  type MainLaunchOptions,
  type MainLaunchSuccess,
  type MainLaunchWorkContext,
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

export {
  buildMainLaunchArgv,
  formatMainLaunchHuman,
  formatMainLaunchJson,
  MAIN_CDP_HOST,
  MAIN_CDP_PORT,
} from "./main-launch-types.ts";
export type {
  LaunchedMainIdentity,
  MainLaunchErrorCode,
  MainLaunchFailureDetails,
  MainLaunchOptions,
  MainLaunchPath,
  MainLaunchStage,
  MainLaunchSuccess,
  MainLaunchWorkContext,
} from "./main-launch-types.ts";

/**
 * Explicit normal launch from no-main with free 9333, or freshly verified attach
 * when a racing winner becomes exact cdp-main before spawn. Never shadows or
 * mutates a plain/user-owned main.
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

      let path: "spawn" | "attach" = "spawn";
      let boundProcess: VerifiedProcess | null = null;
      let spawned: SpawnedProcess | null = null;
      let spawnedByThisOperation = false;
      let surviving: LaunchedMainIdentity | null = null;

      // ── Launch coordination lock ───────────────────────────────────────
      const lock = await acquireStageLock(ctx, {
        explodexHome,
        resource: "main-launch",
        label: "main-launch",
      });
      ctx.markStageComplete("lock-acquisition");
      markLaunchStage(ctx, "lock-acquisition");

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
          // Freshly verified attach path for a racing winner (or already present cdp-main).
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
          const deadline = options.runtime.clock.nowMs() + ctl.remainingMs();
          const pollMs = options.readinessPollMs ?? 50;
          while (options.runtime.clock.nowMs() < deadline) {
            ctl.throwIfInterrupted();
            if (surviving === null) {
              throw launchFailure({
                code: "readiness_failed",
                message: "Missing surviving process during readiness",
                path: "failed",
                lastCompletedStage: "spawn",
                stalledStage: "launch-readiness",
              });
            }
            const alive = surviving.processStartedAt === "unresolved"
              ? true
              : await options.runtime.process.isAlive(
                  surviving.pid,
                  surviving.processStartedAt,
                  { abortSignal: ctl.signal },
                );
            if (!alive) {
              throw launchFailure({
                code: "readiness_failed",
                message: "Launched ChatGPT process exited before readiness",
                path: "failed",
                survivingChatGpt: surviving,
                lastCompletedStage: path === "spawn" ? "spawn" : "pre-spawn-recheck",
                stalledStage: "launch-readiness",
              });
            }

            const status = options.collectStatus !== undefined
              ? await options.collectStatus(ctl.signal)
              : await collectHostStatus({
                  role: "main",
                  adapters: options.statusAdapters,
                  signal: ctl.signal,
                });

            const match = status.processes.find(
              (candidate) =>
                candidate.pid === surviving!.pid &&
                (surviving!.processStartedAt === "unresolved" ||
                  candidate.processStartedAt === surviving!.processStartedAt),
            );
            const ownsPort = status.listeners.some(
              (listener) =>
                listener.pid === surviving!.pid &&
                listener.host === MAIN_CDP_HOST &&
                listener.port === MAIN_CDP_PORT &&
                (surviving!.processStartedAt === "unresolved" ||
                  listener.processStartedAt === surviving!.processStartedAt ||
                  listener.processStartedAt === null),
            );

            if (match !== undefined && ownsPort) {
              if (!ctl.tryCommitEffect()) {
                throw new InterruptError("launch-readiness");
              }
              return match;
            }
            await sleep(options.runtime, pollMs, ctl.signal);
          }
          throw launchFailure({
            code: "readiness_failed",
            message: "Timed out waiting for launched main to own 127.0.0.1:9333",
            path: "failed",
            survivingChatGpt: surviving ?? undefined,
            lastCompletedStage: path === "spawn" ? "spawn" : "pre-spawn-recheck",
            stalledStage: "launch-readiness",
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
                ctx.scope.register({
                  kind: "session",
                  label: `cdp:main:${ctx.identity.operationId}:${session.targetId}`,
                  disposition: "command-owned",
                  dispose: () => session.close(),
                });
              },
            });
            if (inspected.kind !== "available") {
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
              throw launchFailure({
                code: "target_not_found",
                message: "Selected target session was unavailable",
                path: "failed",
                survivingChatGpt: surviving ?? undefined,
                lastCompletedStage: "launch-readiness",
                stalledStage: "cdp-discovery",
              });
            }
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

        // Point-of-use process recheck before requested work
        const aliveBeforeWork = await options.runtime.process.isAlive(
          surviving.pid,
          surviving.processStartedAt,
        );
        if (!aliveBeforeWork) {
          throw launchFailure({
            code: "process_identity_drift",
            message: "Launched process identity changed before requested work",
            path: "failed",
            survivingChatGpt: surviving,
            lastCompletedStage: "cdp-discovery",
            stalledStage: "requested-work",
          });
        }

        // ── Requested work once ──────────────────────────────────────────
        const workResult = await ctx.runExternalWait("cdp-evaluation", async (ctl) => {
          const workCtx: MainLaunchWorkContext = {
            operationId: ctx.identity.operationId,
            host: frozenHost,
            process: surviving!,
            target: discovery.target,
            path,
            signal: ctl.signal,
            throwIfInterrupted: () => ctl.throwIfInterrupted(),
            evaluate: async (expression) => {
              ctl.throwIfInterrupted();
              const hostNow = options.freezeHost !== undefined
                ? await options.freezeHost()
                : await freezeHostOrThrow(options.hostAdapters);
              if (!hostIdentityEqual(frozenHost, hostNow)) {
                throw launchFailure({
                  code: "host_identity_drift",
                  message: "Canonical host identity drifted before evaluation; preserving process without reconnect.",
                  path: "failed",
                  survivingChatGpt: surviving ?? undefined,
                  lastCompletedStage: "cdp-discovery",
                  stalledStage: "requested-work",
                });
              }
              const stillAlive = await options.runtime.process.isAlive(
                surviving!.pid,
                surviving!.processStartedAt,
                { abortSignal: ctl.signal },
              );
              if (!stillAlive) {
                throw launchFailure({
                  code: "process_identity_drift",
                  message: "Process identity changed before evaluation",
                  path: "failed",
                  survivingChatGpt: surviving ?? undefined,
                  lastCompletedStage: "cdp-discovery",
                  stalledStage: "requested-work",
                });
              }
              if (!ctl.tryCommitEffect()) {
                throw new InterruptError("cdp-evaluation");
              }
              return discovery.session.evaluate({
                executionContextId: discovery.target.executionContextId,
                executionContextUniqueId: discovery.target.executionContextUniqueId,
                expression,
                signal: ctl.signal,
              });
            },
          };

          try {
            if (options.work !== undefined) {
              return await options.work(workCtx);
            }
            const evaluation = await workCtx.evaluate(DEFAULT_BENIGN_MAIN_EXPRESSION);
            return { result: evaluation.value, injectionPerformed: false };
          } catch (error: unknown) {
            if (isLaunchFailure(error) || error instanceof InterruptError || error instanceof TimeoutError) {
              throw error;
            }
            throw launchFailure({
              code: "requested_work_failed",
              message: error instanceof Error ? error.message : "Requested work failed",
              path: "failed",
              survivingChatGpt: surviving ?? undefined,
              lastCompletedStage: "cdp-discovery",
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
          work: workResult.result,
          stagesCompleted,
          spawnedByThisOperation,
          chatgptSurvives: true as const,
          injectionClaimed: workResult.injectionPerformed === true,
        } satisfies MainLaunchSuccess;
      } finally {
        // Lock is released via scope dispose. Never signal protected ChatGPT.
        void lock;
        void signalsSent;
        markLaunchStage(ctx, "cleanup");
      }
    },
  }).then((result) => normalizeLaunchResult(result));
}
