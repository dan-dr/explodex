import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STAGE_BOUNDS_MS,
  runBoundedOperation,
  TimeoutError,
  InterruptError,
  createResourceScope,
  assertNoResidentControlPlane,
  acquireOperationLock,
  releaseOperationLock,
  withOperationLock,
  parseOperationLockRecord,
  lockPath,
  leasePath,
} from "../../src/runtime/index.ts";
import { createFakeRuntimeHarness, runWithClockPump } from "./fixture-runtime.ts";

describe("bounded operation runtime — no resident control plane (VAL-HOST-027)", () => {
  test("successful one-shot leaves empty residual inventory", async () => {
    const harness = createFakeRuntimeHarness();
    const delayedObservations: Array<ReturnType<typeof harness.adapters.clock.nowMs>> = [];

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "host-inspect",
      operationId: "op-success-1",
      run: async (ctx) => {
        const sessionClosed = { value: false };
        ctx.scope.register({
          kind: "session",
          label: "cdp-session",
          disposition: "command-owned",
          dispose: () => {
            sessionClosed.value = true;
          },
        });
        const callbackInert = { value: false };
        ctx.scope.register({
          kind: "callback",
          label: "review-callback",
          disposition: "command-owned",
          dispose: () => {
            callbackInert.value = true;
          },
        });
        await ctx.runLocal("local-work", async () => "ok");
        ctx.markStageComplete("local-work");
        expect(sessionClosed.value).toBe(false);
        return { value: "ok", sessionClosed, callbackInert };
      },
      afterDispose: () => {
        delayedObservations.push(harness.nowMs());
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
    expect(result.residualInventory.openLockDescriptors).toBe(0);
    expect(result.residualInventory.advisoryLeasesHeld).toBe(0);
    expect(result.residualInventory.sessions).toBe(0);
    expect(result.residualInventory.callbacks).toBe(0);
    expect(result.residualInventory.commandOwnedChildren).toBe(0);
    expect(result.residualInventory.locksHeld).toBe(0);
    expect(result.residualInventory.watchers).toBe(0);
    expect(result.residualInventory.sockets).toBe(0);
    expect(result.residualInventory.reconnectLoops).toBe(0);
    expect(result.residualInventory.approvalListeners).toBe(0);
    expect(result.residualInventory.daemons).toBe(0);
    expect(result.result.sessionClosed.value).toBe(true);
    expect(result.result.callbackInert.value).toBe(true);
    expect(delayedObservations.length).toBe(1);
  });

  test("failure path still disposes sessions, locks, callbacks, and children", async () => {
    const harness = createFakeRuntimeHarness();
    const disposed: string[] = [];

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "inject",
      operationId: "op-fail-1",
      run: async (ctx) => {
        ctx.scope.register({
          kind: "session",
          label: "cdp",
          disposition: "command-owned",
          dispose: () => {
            disposed.push("session");
          },
        });
        ctx.scope.register({
          kind: "lock",
          label: "plugins-state",
          disposition: "command-owned",
          dispose: () => {
            disposed.push("lock");
          },
        });
        ctx.scope.register({
          kind: "child-process",
          label: "helper",
          disposition: "command-owned",
          pid: 55_001,
          processStartedAt: "2026-07-23T12:00:01.000Z",
          dispose: () => {
            disposed.push("child");
          },
        });
        harness.setProcessAlive(55_001, "2026-07-23T12:00:01.000Z", true);
        harness.setSignalDisposition(55_001, "2026-07-23T12:00:01.000Z", "exit");
        throw new Error("evaluation blew up");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_failed");
    expect(disposed).toContain("session");
    expect(disposed).toContain("lock");
    expect(disposed).toContain("child");
    // Command-owned child was signaled during reap.
    expect(harness.signalsSent.some((s) => s.pid === 55_001)).toBe(true);
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
  });

  test("cleanup failure remains truthful in residual inventory", async () => {
    const harness = createFakeRuntimeHarness();

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "status",
      operationId: "op-cleanup-failure",
      run: async (ctx) => {
        ctx.scope.register({
          kind: "session",
          label: "broken-session",
          disposition: "command-owned",
          dispose: () => {
            throw new Error("session close failed");
          },
        });
        return "done";
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(result.error.stage).toBe("cleanup");
    expect(result.residualInventory.sessions).toBe(1);
    expect(result.residualInventory.hasResidentControlPlane).toBe(true);
    expect(result.error.details).toEqual(expect.objectContaining({
      failures: expect.arrayContaining([
        expect.objectContaining({ label: "broken-session", outcome: "failed" }),
      ]),
    }));
  });

  test("hanging disposer is bounded and reported as cleanup failure", async () => {
    const harness = createFakeRuntimeHarness();

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "status",
      operationId: "op-cleanup-timeout",
      stageBounds: { "owned-child-shutdown": 25 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "callback",
          label: "hung-callback",
          disposition: "command-owned",
          dispose: () => new Promise<void>(() => undefined),
        });
        return "done";
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 20 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(result.error.stage).toBe("cleanup");
    expect(result.error.boundMs).toBe(25);
    expect(result.residualInventory.callbacks).toBe(1);
    expect(result.error.details).toEqual(expect.objectContaining({
      failures: expect.arrayContaining([
        expect.objectContaining({ label: "hung-callback", outcome: "timed-out" }),
      ]),
    }));
  });

  test("one hanging disposer cannot starve later LIFO cleanup hooks", async () => {
    const harness = createFakeRuntimeHarness();
    const attempts: string[] = [];

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "status",
      operationId: "op-cleanup-fairness",
      stageBounds: { "owned-child-shutdown": 30 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "session",
          label: "session",
          disposition: "command-owned",
          dispose: () => {
            attempts.push("session");
          },
        });
        ctx.scope.register({
          kind: "lock",
          label: "lock",
          disposition: "command-owned",
          dispose: () => {
            attempts.push("lock");
          },
        });
        ctx.scope.register({
          kind: "callback",
          label: "hung-callback",
          disposition: "command-owned",
          dispose: () => {
            attempts.push("callback");
            return new Promise<void>(() => undefined);
          },
        });
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 1, maxSteps: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(attempts).toEqual(["callback", "lock", "session"]);
    expect(result.residualInventory.callbacks).toBe(1);
    expect(result.residualInventory.locksHeld).toBe(0);
    expect(result.residualInventory.sessions).toBe(0);
  });

  test("stubborn child cleanup cannot starve unrelated disposers", async () => {
    const harness = createFakeRuntimeHarness();
    const child = { pid: 55_075, start: "stubborn-child" };
    const attempts: string[] = [];
    harness.setProcessAlive(child.pid, child.start, true);
    harness.setSignalDisposition(child.pid, child.start, "remain-alive");

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "status",
      operationId: "op-child-disposer-overlap",
      stageBounds: { "owned-child-shutdown": 30 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "session",
          label: "session",
          disposition: "command-owned",
          dispose: () => {
            attempts.push("session");
          },
        });
        ctx.scope.register({
          kind: "lock",
          label: "lock",
          disposition: "command-owned",
          dispose: () => {
            attempts.push("lock");
          },
        });
        ctx.scope.register({
          kind: "child-process",
          label: "stubborn-helper",
          disposition: "command-owned",
          pid: child.pid,
          processStartedAt: child.start,
          dispose: () => {
            attempts.push("child");
          },
        });
        return null;
      },
    });

    const startedAt = harness.nowMs();
    const result = await runWithClockPump(harness, work, { stepMs: 1, maxSteps: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(harness.nowMs() - startedAt).toBeLessThanOrEqual(35);
    expect(attempts).toEqual(expect.arrayContaining(["child", "lock", "session"]));
    expect(result.residualInventory.commandOwnedChildren).toBe(1);
    expect(result.residualInventory.locksHeld).toBe(0);
    expect(result.residualInventory.sessions).toBe(0);
  });

  test("timed-out disposer is aborted and cannot commit a late effect", async () => {
    const harness = createFakeRuntimeHarness();
    let lateEffects = 0;
    let sawAbort = false;

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "status",
      operationId: "op-cleanup-effect-fence",
      stageBounds: { "owned-child-shutdown": 20 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "callback",
          label: "late-cleanup-callback",
          disposition: "command-owned",
          dispose: async (control) => {
            control.signal.addEventListener("abort", () => {
              sawAbort = true;
            }, { once: true });
            await new Promise<void>((resolve) => {
              harness.adapters.timers.setTimeout(resolve, 100);
            });
            if (control.tryCommitEffect()) lateEffects += 1;
          },
        });
        return "done";
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 20 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(sawAbort).toBe(true);

    harness.advanceMs(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateEffects).toBe(0);
  });

  test("protected child runs detach cleanup without receiving a signal", async () => {
    const harness = createFakeRuntimeHarness();
    let detached = false;

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "launch-with-injection",
      operationId: "op-protected-detach",
      run: async (ctx) => {
        ctx.scope.register({
          kind: "child-process",
          label: "launched-chatgpt",
          disposition: "protected-chatgpt",
          pid: 55_100,
          processStartedAt: "chatgpt-start",
          dispose: () => {
            detached = true;
          },
        });
        return null;
      },
    });

    expect(result.ok).toBe(true);
    expect(detached).toBe(true);
    expect(harness.signalsSent.some((entry) => entry.pid === 55_100)).toBe(false);
  });

  test("repetition does not accumulate residual control-plane resources", async () => {
    const harness = createFakeRuntimeHarness();

    for (let i = 0; i < 5; i += 1) {
      const result = await runBoundedOperation({
        adapters: harness.adapters,
        operation: "status",
        operationId: `op-repeat-${i}`,
        run: async (ctx) => {
          ctx.scope.register({
            kind: "socket",
            label: "temp",
            disposition: "command-owned",
            dispose: () => undefined,
          });
          ctx.scope.register({
            kind: "watcher",
            label: "temp-watch",
            disposition: "command-owned",
            dispose: () => undefined,
          });
          return i;
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.residualInventory.hasResidentControlPlane).toBe(false);
    }
  });

  test("registering a reconnect-loop is forbidden", async () => {
    const harness = createFakeRuntimeHarness();
    const scope = createResourceScope({
      operationId: "op-reconnect",
      process: harness.adapters.process,
      clock: harness.adapters.clock,
      timers: harness.adapters.timers,
    });
    expect(() =>
      scope.register({
        kind: "reconnect-loop",
        label: "bad",
        disposition: "command-owned",
        dispose: () => undefined,
      }),
    ).toThrow(/resident_control_plane_forbidden/);
  });

  test("protected ChatGPT child is never signaled on any terminal path", async () => {
    const harness = createFakeRuntimeHarness();
    const chatgptPid = 42_000;
    const chatgptStart = "2026-07-23T11:00:00.000Z";
    harness.setProcessAlive(chatgptPid, chatgptStart, true);

    for (const mode of ["success", "failure", "timeout", "interrupt"] as const) {
      harness.signalsSent.length = 0;
      const opId = `op-protect-${mode}`;

      if (mode === "success") {
        const result = await runBoundedOperation({
          adapters: harness.adapters,
          operation: "launch-with-injection",
          operationId: opId,
          run: async (ctx) => {
            ctx.scope.register({
              kind: "child-process",
              label: "launched-chatgpt",
              disposition: "protected-chatgpt",
              pid: chatgptPid,
              processStartedAt: chatgptStart,
              dispose: () => undefined,
            });
            ctx.setPartial({
              survivingChatGpt: {
                pid: chatgptPid,
                processStartedAt: chatgptStart,
                port: 9333,
              },
            });
            return { launched: true };
          },
        });
        expect(result.ok).toBe(true);
      } else if (mode === "failure") {
        const result = await runBoundedOperation({
          adapters: harness.adapters,
          operation: "launch-with-injection",
          operationId: opId,
          run: async (ctx) => {
            ctx.scope.register({
              kind: "child-process",
              label: "launched-chatgpt",
              disposition: "protected-chatgpt",
              pid: chatgptPid,
              processStartedAt: chatgptStart,
              dispose: () => undefined,
            });
            ctx.setPartial({
              survivingChatGpt: {
                pid: chatgptPid,
                processStartedAt: chatgptStart,
                port: 9333,
              },
            });
            throw new Error("post-spawn evaluation failed");
          },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.partial.survivingChatGpt?.pid).toBe(chatgptPid);
        }
      } else if (mode === "timeout") {
        const work = runBoundedOperation({
          adapters: harness.adapters,
          operation: "launch-with-injection",
          operationId: opId,
          stageBounds: { "launch-readiness": 50 },
          run: async (ctx) => {
            ctx.scope.register({
              kind: "child-process",
              label: "launched-chatgpt",
              disposition: "protected-chatgpt",
              pid: chatgptPid,
              processStartedAt: chatgptStart,
              dispose: () => undefined,
            });
            ctx.setPartial({
              survivingChatGpt: {
                pid: chatgptPid,
                processStartedAt: chatgptStart,
                port: 9333,
              },
            });
            await ctx.runExternalWait("launch-readiness", async (ctl) => {
              // Hang until timeout.
              await new Promise<void>((resolve, reject) => {
                const check = (): void => {
                  if (ctl.isInterrupted()) {
                    reject(new InterruptError("launch-readiness"));
                    return;
                  }
                  harness.adapters.timers.setTimeout(check, 5);
                };
                check();
                void resolve;
              });
              return "never";
            });
            return null;
          },
        });
        const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 50 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("operation_timeout");
          expect(result.error.stage).toBe("launch-readiness");
          expect(result.partial.survivingChatGpt?.pid).toBe(chatgptPid);
        }
      } else {
        // interrupt
        const work = runBoundedOperation({
          adapters: harness.adapters,
          operation: "launch-with-injection",
          operationId: opId,
          stageBounds: { "cdp-discovery": 5_000 },
          run: async (ctx) => {
            ctx.scope.register({
              kind: "child-process",
              label: "launched-chatgpt",
              disposition: "protected-chatgpt",
              pid: chatgptPid,
              processStartedAt: chatgptStart,
              dispose: () => undefined,
            });
            ctx.setPartial({
              survivingChatGpt: {
                pid: chatgptPid,
                processStartedAt: chatgptStart,
                port: 9333,
              },
            });
            await ctx.runExternalWait("cdp-discovery", async (ctl) => {
              // Schedule interrupt shortly after wait starts.
              harness.adapters.timers.setTimeout(() => {
                harness.emitSignal("SIGINT");
              }, 20);
              await new Promise<void>((resolve, reject) => {
                const tick = (): void => {
                  if (ctl.isInterrupted()) {
                    reject(new InterruptError("cdp-discovery"));
                    return;
                  }
                  harness.adapters.timers.setTimeout(tick, 5);
                };
                tick();
                void resolve;
              });
              return "never";
            });
            return null;
          },
        });
        const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 200 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("operation_interrupted");
          expect(result.partial.survivingChatGpt?.pid).toBe(chatgptPid);
        }
      }

      expect(harness.signalsSent.some((s) => s.pid === chatgptPid)).toBe(false);
    }
  });

  test("assertNoResidentControlPlane throws when residue remains", () => {
    expect(() =>
      assertNoResidentControlPlane({
        commandOwnedChildren: 1,
        sessions: 0,
        locksHeld: 0,
        callbacks: 0,
        watchers: 0,
        sockets: 0,
        futureDocuments: 0,
        reconnectLoops: 0,
        approvalListeners: 0,
        daemons: 0,
        supervisors: 0,
        openLockDescriptors: 0,
        advisoryLeasesHeld: 0,
        hasResidentControlPlane: true,
      }),
    ).toThrow(/resident_control_plane_forbidden/);
  });
});

describe("bounded operation runtime — stage timeouts (VAL-HOST-028)", () => {
  test("default bounds cover every required external-wait stage", () => {
    const required: Array<keyof typeof DEFAULT_STAGE_BOUNDS_MS> = [
      "launch-readiness",
      "cdp-discovery",
      "cdp-evaluation",
      "renderer-response",
      "approval",
      "http-download",
      "owned-child-shutdown",
      "lock-acquisition",
    ];
    for (const stage of required) {
      expect(typeof DEFAULT_STAGE_BOUNDS_MS[stage]).toBe("number");
      expect(DEFAULT_STAGE_BOUNDS_MS[stage]).toBeGreaterThan(0);
    }
  });

  test("stalled external wait returns structured timeout with stage and bound", async () => {
    const harness = createFakeRuntimeHarness();
    const boundMs = 40;

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-timeout-stage",
      stageBounds: { "cdp-evaluation": boundMs },
      run: async (ctx) => {
        ctx.markStageComplete("preflight");
        await ctx.runExternalWait("cdp-evaluation", async () => {
          await new Promise<void>((resolve) => {
            // Never resolves before bound; keep a hanging timer.
            harness.adapters.timers.setTimeout(() => resolve(), 10_000);
          });
          return "done";
        });
        return "unreachable";
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_timeout");
    expect(result.error.stage).toBe("cdp-evaluation");
    expect(result.error.boundMs).toBe(boundMs);
    expect(result.partial.stalledStage).toBe("cdp-evaluation");
    expect(result.stagesCompleted).toContain("preflight");
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
  });

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
  ])("rejects invalid external stage bound %p before command work", async (boundMs) => {
    const harness = createFakeRuntimeHarness();
    let started = false;

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: `op-invalid-bound-${String(boundMs)}`,
      stageBounds: { "cdp-discovery": boundMs },
      run: async () => {
        started = true;
        return null;
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_stage_bound");
    expect(result.error.stage).toBe("cdp-discovery");
    expect(result.error.boundMs).toBe(boundMs);
    expect(started).toBe(false);
  });

  test("timeout aborts and fences late stage effects", async () => {
    const harness = createFakeRuntimeHarness();
    let lateEffects = 0;
    let sawAbort = false;

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-timeout-fence",
      stageBounds: { "renderer-response": 20 },
      run: async (ctx) => {
        await ctx.runExternalWait("renderer-response", async (ctl) => {
          await new Promise<void>((resolve) => {
            ctl.signal.addEventListener("abort", () => {
              sawAbort = true;
            }, { once: true });
            harness.adapters.timers.setTimeout(() => resolve(), 100);
          });
          if (!ctl.tryCommitEffect()) return;
          lateEffects += 1;
        });
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 20 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_timeout");
    expect(sawAbort).toBe(true);

    harness.advanceMs(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateEffects).toBe(0);
  });

  test("effect claimed before timeout is awaited as a registered resource", async () => {
    const harness = createFakeRuntimeHarness();
    let effectCompleted = false;

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-effect-in-flight",
      stageBounds: { "renderer-response": 20, "owned-child-shutdown": 30 },
      run: async (ctx) => {
        await ctx.runExternalWait("renderer-response", async (ctl) => {
          if (!ctl.tryCommitEffect()) return;
          const effect = new Promise<void>((resolve) => {
            harness.adapters.timers.setTimeout(() => {
              effectCompleted = true;
              resolve();
            }, 25);
          });
          ctx.scope.register({
            kind: "callback",
            label: "in-flight-effect",
            disposition: "command-owned",
            dispose: () => effect,
          });
          await new Promise<void>(() => undefined);
        });
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 20 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_timeout");
    expect(effectCompleted).toBe(true);
    expect(result.residualInventory.callbacks).toBe(0);
  });

  test("runLocal effect control is inactive after the local stage returns", async () => {
    const harness = createFakeRuntimeHarness();
    let retainedControl: { tryCommitEffect(): boolean } | null = null;

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "status",
      operationId: "op-local-effect-fence",
      run: async (ctx) => {
        await ctx.runLocal("local-work", async (control) => {
          retainedControl = control;
        });
        expect(retainedControl?.tryCommitEffect()).toBe(false);
        return null;
      },
    });

    expect(result.ok).toBe(true);
  });

  test("runLocal rejects external-wait stages at runtime", async () => {
    const harness = createFakeRuntimeHarness();
    let started = false;

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "local-build",
      operationId: "op-local-external-stage",
      run: async (ctx) => {
        await ctx.runLocal("http-download" as never, async () => {
          started = true;
        });
        return null;
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("external_wait_requires_bound");
    expect(result.error.stage).toBe("http-download");
    expect(started).toBe(false);
  });

  test.each([
    ["launch-readiness", 30] as const,
    ["cdp-discovery", 25] as const,
    ["http-download", 35] as const,
    ["owned-child-shutdown", 20] as const,
    ["approval", 45] as const,
  ])("timeout matrix stage %s cleans sessions and locks", async (stage, boundMs) => {
    const harness = createFakeRuntimeHarness();
    const disposed: string[] = [];

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "representative",
      operationId: `op-to-${stage}`,
      stageBounds: { [stage]: boundMs },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "session",
          label: "s",
          disposition: "command-owned",
          dispose: () => {
            disposed.push("session");
          },
        });
        ctx.scope.register({
          kind: "lock",
          label: "l",
          disposition: "command-owned",
          dispose: () => {
            disposed.push("lock");
          },
        });
        ctx.scope.register({
          kind: "callback",
          label: "c",
          disposition: "command-owned",
          dispose: () => {
            disposed.push("callback");
          },
        });
        await ctx.runExternalWait(stage, async () => {
          await new Promise<void>((resolve) => {
            harness.adapters.timers.setTimeout(() => resolve(), 10_000);
          });
          return null;
        });
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, {
      stepMs: 5,
      maxSteps: Math.ceil(boundMs / 5) + 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      stage === "owned-child-shutdown" ? "cleanup_failed" : "operation_timeout",
    );
    expect(result.error.stage).toBe(stage === "owned-child-shutdown" ? "cleanup" : stage);
    expect(result.error.boundMs).toBe(boundMs);
    const expectedDisposed =
      stage === "owned-child-shutdown" ? ["lock", "callback"] : ["session", "lock", "callback"];
    expect(disposed).toEqual(expect.arrayContaining(expectedDisposed));
    if (stage !== "owned-child-shutdown") {
      expect(result.residualInventory.hasResidentControlPlane).toBe(false);
    } else {
      expect(result.residualInventory.sessions).toBe(1);
    }
  });

  test("TimeoutError is distinguishable for callers", () => {
    const err = new TimeoutError("renderer-response", 15_000);
    expect(err.code).toBe("operation_timeout");
    expect(err.stage).toBe("renderer-response");
    expect(err.boundMs).toBe(15_000);
  });

  test("timeout cleanup reaps only command-owned children, not protected ChatGPT", async () => {
    const harness = createFakeRuntimeHarness();
    const helperPid = 70_001;
    const chatgptPid = 70_002;
    harness.setProcessAlive(helperPid, "t1", true);
    harness.setSignalDisposition(helperPid, "t1", "exit");
    harness.setProcessAlive(chatgptPid, "t2", true);

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "launch-with-injection",
      operationId: "op-to-reap",
      stageBounds: { "renderer-response": 30 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "child-process",
          label: "helper",
          disposition: "command-owned",
          pid: helperPid,
          processStartedAt: "t1",
          dispose: () => undefined,
        });
        ctx.scope.register({
          kind: "child-process",
          label: "chatgpt",
          disposition: "protected-chatgpt",
          pid: chatgptPid,
          processStartedAt: "t2",
          dispose: () => undefined,
        });
        ctx.setPartial({
          survivingChatGpt: { pid: chatgptPid, processStartedAt: "t2", port: 9333 },
        });
        await ctx.runExternalWait("renderer-response", async () => {
          await new Promise<void>((resolve) => {
            harness.adapters.timers.setTimeout(() => resolve(), 10_000);
          });
          return null;
        });
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 2_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_timeout");
    expect(harness.signalsSent.filter((s) => s.pid === helperPid).length).toBeGreaterThan(0);
    expect(harness.signalsSent.filter((s) => s.pid === chatgptPid).length).toBe(0);
    expect(result.partial.survivingChatGpt?.pid).toBe(chatgptPid);
  });

  test("revalidates child start identity immediately before signaling", async () => {
    const harness = createFakeRuntimeHarness();
    const helperPid = 70_100;
    const originalStart = "helper-original";
    const replacementStart = "helper-replacement";
    harness.setProcessAlive(helperPid, originalStart, true);
    harness.setSignalBarrier(() => {
      harness.setProcessAlive(helperPid, originalStart, false);
      harness.setProcessAlive(helperPid, replacementStart, true);
    });

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-pid-reuse",
      run: async (ctx) => {
        ctx.scope.register({
          kind: "child-process",
          label: "helper",
          disposition: "command-owned",
          pid: helperPid,
          processStartedAt: originalStart,
          dispose: () => undefined,
        });
        throw new Error("trigger cleanup");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(harness.signalsSent.some((entry) => entry.pid === helperPid)).toBe(false);
    expect(result.error.details).toEqual(expect.objectContaining({
      failures: expect.arrayContaining([
        expect.objectContaining({ label: "helper", outcome: "identity-mismatch" }),
      ]),
    }));
  });

  test("rejects invalid command-owned child PID registration", async () => {
    const harness = createFakeRuntimeHarness();

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-invalid-child-pid",
      run: async (ctx) => {
        ctx.scope.register({
          kind: "child-process",
          label: "invalid-helper",
          disposition: "command-owned",
          pid: 0,
          processStartedAt: "invalid-start",
          dispose: () => undefined,
        });
        throw new Error("trigger cleanup");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(result.error.details).toEqual(expect.objectContaining({
      failures: expect.arrayContaining([
        expect.objectContaining({ label: "invalid-helper", outcome: "invalid-registration" }),
      ]),
    }));
  });

  test("signals all command-owned children before waiting for exits", async () => {
    const harness = createFakeRuntimeHarness();
    const first = { pid: 60_001, start: "first-child" };
    const second = { pid: 60_002, start: "second-child" };
    for (const child of [first, second]) {
      harness.setProcessAlive(child.pid, child.start, true);
      harness.setSignalDisposition(child.pid, child.start, { exitAfterMs: 15 });
    }

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-signal-all-children",
      stageBounds: { "owned-child-shutdown": 100 },
      run: async (ctx) => {
        for (const child of [first, second]) {
          ctx.scope.register({
            kind: "child-process",
            label: `helper-${child.pid}`,
            disposition: "command-owned",
            pid: child.pid,
            processStartedAt: child.start,
            dispose: () => undefined,
          });
        }
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 1, maxSteps: 100 });
    expect(result.ok).toBe(true);
    expect(harness.signalsSent.map((entry) => entry.pid)).toEqual([first.pid, second.pid]);
  });

  test("reports command-owned child that ignores graceful shutdown", async () => {
    const harness = createFakeRuntimeHarness();
    const helperPid = 70_200;
    harness.setProcessAlive(helperPid, "helper-start", true);
    harness.setSignalDisposition(helperPid, "helper-start", "remain-alive");

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-child-survives",
      stageBounds: { "owned-child-shutdown": 20 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "child-process",
          label: "stubborn-helper",
          disposition: "command-owned",
          pid: helperPid,
          processStartedAt: "helper-start",
          dispose: () => undefined,
        });
        throw new Error("trigger cleanup");
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 20 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(result.error.boundMs).toBe(20);
    expect(result.residualInventory.commandOwnedChildren).toBe(1);
    expect(harness.signalsSent.some((entry) => entry.pid === helperPid)).toBe(true);
  });
});

describe("bounded operation runtime — cooperative SIGINT (VAL-HOST-029)", () => {
  test("first SIGINT during external wait yields stable interrupted outcome", async () => {
    const harness = createFakeRuntimeHarness();
    const disposed: string[] = [];

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "refresh",
      operationId: "op-sigint-1",
      stageBounds: { "cdp-discovery": 5_000 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "session",
          label: "cdp",
          disposition: "command-owned",
          dispose: () => {
            disposed.push("session");
          },
        });
        ctx.scope.register({
          kind: "lock",
          label: "main-launch",
          disposition: "command-owned",
          dispose: () => {
            disposed.push("lock");
          },
        });
        ctx.markStageComplete("preflight");
        await ctx.runExternalWait("cdp-discovery", async (ctl) => {
          harness.adapters.timers.setTimeout(() => harness.emitSignal("SIGINT"), 15);
          await new Promise<void>((resolve, reject) => {
            const tick = (): void => {
              if (ctl.isInterrupted()) {
                reject(new InterruptError("cdp-discovery"));
                return;
              }
              harness.adapters.timers.setTimeout(tick, 5);
            };
            tick();
            void resolve;
          });
          return null;
        });
        // Must not run after interrupt.
        ctx.markStageComplete("cdp-evaluation");
        return "should-not-complete";
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_interrupted");
    expect(result.error.stage).toBe("cdp-discovery");
    expect(result.stagesCompleted).toContain("preflight");
    expect(result.stagesCompleted).not.toContain("cdp-evaluation");
    expect(disposed).toEqual(expect.arrayContaining(["session", "lock"]));
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
  });

  test("SIGINT during local work is observed cooperatively", async () => {
    const harness = createFakeRuntimeHarness();

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "local-build",
      operationId: "op-sigint-local",
      run: async (ctx) => {
        await ctx.runLocal("local-work", async (ctl) => {
          harness.emitSignal("SIGINT");
          ctl.throwIfInterrupted();
          return "nope";
        });
        return "nope";
      },
    });

    const result = await work;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_interrupted");
  });

  test("SIGINT reaps command-owned children and never signals protected ChatGPT", async () => {
    const harness = createFakeRuntimeHarness();
    const helperPid = 80_001;
    const chatgptPid = 80_002;
    harness.setProcessAlive(helperPid, "h", true);
    harness.setSignalDisposition(helperPid, "h", "exit");
    harness.setProcessAlive(chatgptPid, "c", true);

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "launch-with-injection",
      operationId: "op-sigint-reap",
      stageBounds: { "launch-readiness": 5_000 },
      run: async (ctx) => {
        ctx.scope.register({
          kind: "child-process",
          label: "helper",
          disposition: "command-owned",
          pid: helperPid,
          processStartedAt: "h",
          dispose: () => undefined,
        });
        ctx.scope.register({
          kind: "child-process",
          label: "chatgpt",
          disposition: "protected-chatgpt",
          pid: chatgptPid,
          processStartedAt: "c",
          dispose: () => undefined,
        });
        ctx.setPartial({
          survivingChatGpt: { pid: chatgptPid, processStartedAt: "c", port: 9333 },
          alreadyApplied: { stage: "spawned" },
        });
        await ctx.runExternalWait("launch-readiness", async (ctl) => {
          harness.adapters.timers.setTimeout(() => harness.emitSignal("SIGINT"), 10);
          await new Promise<void>((resolve, reject) => {
            const tick = (): void => {
              if (ctl.isInterrupted()) {
                reject(new InterruptError("launch-readiness"));
                return;
              }
              harness.adapters.timers.setTimeout(tick, 5);
            };
            tick();
            void resolve;
          });
          return null;
        });
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_interrupted");
    expect(result.partial.survivingChatGpt?.pid).toBe(chatgptPid);
    expect(result.partial.alreadyApplied).toEqual({ stage: "spawned" });
    expect(harness.signalsSent.some((s) => s.pid === helperPid)).toBe(true);
    expect(harness.signalsSent.some((s) => s.pid === chatgptPid)).toBe(false);
  });

  test("second SIGINT is ignored once already interrupted", async () => {
    const harness = createFakeRuntimeHarness();
    let interruptCount = 0;

    const work = runBoundedOperation({
      adapters: harness.adapters,
      operation: "attach",
      operationId: "op-double-sigint",
      stageBounds: { "cdp-discovery": 5_000 },
      run: async (ctx) => {
        await ctx.runExternalWait("cdp-discovery", async (ctl) => {
          harness.adapters.timers.setTimeout(() => {
            harness.emitSignal("SIGINT");
            harness.emitSignal("SIGINT");
            interruptCount += 1;
          }, 10);
          await new Promise<void>((resolve, reject) => {
            const tick = (): void => {
              if (ctl.isInterrupted()) {
                reject(new InterruptError("cdp-discovery"));
                return;
              }
              harness.adapters.timers.setTimeout(tick, 5);
            };
            tick();
            void resolve;
          });
          return null;
        });
        return null;
      },
    });

    const result = await runWithClockPump(harness, work, { stepMs: 5, maxSteps: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("operation_interrupted");
    expect(interruptCount).toBe(1);
  });
});

describe("operation locks (parent-held Darwin lease)", () => {
  const ownerPath = (home: string, resource: "plugins-state" | "main-launch"): string =>
    `${lockPath(home, resource)}/owner.json`;
  const identity = (harness: ReturnType<typeof createFakeRuntimeHarness>, operationId: string) => ({
    operationId,
    operation: "test-operation",
    startedAt: harness.adapters.clock.nowIso(),
    ownerPid: harness.self.pid,
    ownerProcessStartedAt: harness.self.processStartedAt,
  });

  test("persistent container retains one stable lease inode across acquire and release", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-stable-lock";
    const first = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-first"),
      waitBoundMs: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stableStat = await harness.adapters.fs.statPath(first.leasePath);
    expect(first.closeOnExec).toBe(true);
    expect(harness.openLockDescriptorCount()).toBe(1);
    expect(harness.heldLeaseCount()).toBe(1);

    const busy = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-busy"),
      waitBoundMs: 0,
    });
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.code).toBe("lock_busy");

    await releaseOperationLock(harness.adapters, first.handle);
    expect(first.handle.state()).toEqual({
      descriptorOpen: false,
      leaseHeld: false,
      releasedMetadataWritten: true,
    });
    expect(harness.openLockDescriptorCount()).toBe(0);
    expect(harness.heldLeaseCount()).toBe(0);
    expect(JSON.parse(harness.files.get(ownerPath(home, "plugins-state")) ?? "null").state)
      .toBe("released");

    const second = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-second"),
      waitBoundMs: 0,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const repeatedStat = await harness.adapters.fs.statPath(second.leasePath);
    expect(repeatedStat.inode).toBe(stableStat.inode);
    await second.handle.release();
  });

  test("contended kernel lease is never broken from malformed or stale metadata", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-contended-metadata";
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-owner"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.files.set(ownerPath(home, "plugins-state"), "{malformed");
    const contender = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-contender"),
      waitBoundMs: 0,
    });
    expect(contender.ok).toBe(false);
    if (contender.ok) return;
    expect(contender.code).toBe("lock_busy");
    expect(harness.openLockDescriptorCount()).toBe(1);
    harness.files.set(ownerPath(home, "plugins-state"), `${JSON.stringify(acquired.record)}\n`);
    await acquired.handle.release();
  });

  test("free lease recovers exact dead or start-mismatched held metadata", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-stale-held";
    const first = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "main-launch",
      identity: identity(harness, "op-dead"),
      waitBoundMs: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.handle.release();
    const stale = { ...first.record, state: "held" as const, releasedAt: null };
    harness.files.set(ownerPath(home, "main-launch"), `${JSON.stringify(stale)}\n`);
    harness.setProcessAlive(stale.pid, stale.processStartedAt, false);

    const recovered = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "main-launch",
      identity: identity(harness, "op-recovered"),
      waitBoundMs: 0,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.recoveredStale).toBe(true);
    await recovered.handle.release();
  });

  test("free lease plus exact live recorded owner fails closed", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-live-free-invariant";
    const first = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "main-launch",
      identity: identity(harness, "op-live"),
      waitBoundMs: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.handle.release();
    harness.files.set(ownerPath(home, "main-launch"), `${JSON.stringify(first.record)}\n`);
    harness.setProcessAlive(first.record.pid, first.record.processStartedAt, true);

    const refused = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "main-launch",
      identity: identity(harness, "op-refused"),
      waitBoundMs: 0,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("lock_invariant_violation");
    expect(harness.openLockDescriptorCount()).toBe(0);
  });

  test.each([
    ["legacy regular file", "regular-file", 0o600],
    ["symlink container", "symlink", 0o700],
    ["special container", "special", 0o700],
    ["wrong-mode container", "directory", 0o755],
  ] as const)("fails closed for %s", async (_label, kind, mode) => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-invalid-container";
    const path = lockPath(home, "plugins-state");
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true, mode: 0o700 });
    harness.replacePath(path, { kind, mode });
    const result = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-invalid"),
      waitBoundMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("lock_stale_unrecoverable");
  });

  test("fails closed for symlink, special, wrong-owner, wrong-mode, and substituted lease paths", async () => {
    const cases = [
      { kind: "symlink" as const, mode: 0o600, uid: 501 },
      { kind: "special" as const, mode: 0o600, uid: 501 },
      { kind: "regular-file" as const, mode: 0o644, uid: 501 },
      { kind: "regular-file" as const, mode: 0o600, uid: 777 },
    ];
    for (const [index, replacement] of cases.entries()) {
      const harness = createFakeRuntimeHarness();
      const home = `/tmp/explodex-invalid-lease-${index}`;
      const first = await acquireOperationLock({
        adapters: harness.adapters,
        explodexHome: home,
        resource: "plugins-state",
        identity: identity(harness, `op-first-${index}`),
        waitBoundMs: 0,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      await first.handle.release();
      harness.replacePath(leasePath(home, "plugins-state"), replacement);
      const result = await acquireOperationLock({
        adapters: harness.adapters,
        explodexHome: home,
        resource: "plugins-state",
        identity: identity(harness, `op-invalid-${index}`),
        waitBoundMs: 0,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("lock_stale_unrecoverable");
    }
  });

  test("held publication failure closes the descriptor", async () => {
    const harness = createFakeRuntimeHarness();
    harness.setLockFault("atomic-write");
    await expect(acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-held-write-failure",
      resource: "plugins-state",
      identity: identity(harness, "op-held-write-failure"),
      waitBoundMs: 0,
    })).rejects.toThrow(/Injected atomic write failure/);
    expect(harness.openLockDescriptorCount()).toBe(0);
    expect(harness.heldLeaseCount()).toBe(0);
  });

  test("release publication failure still closes the descriptor unconditionally", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-release-write-failure",
      resource: "plugins-state",
      identity: identity(harness, "op-release-write-failure"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setLockFault("atomic-write");
    await expect(acquired.handle.release()).rejects.toThrow(/Injected atomic write failure/);
    expect(acquired.handle.state().descriptorOpen).toBe(false);
    expect(acquired.handle.state().leaseHeld).toBe(false);
    expect(harness.openLockDescriptorCount()).toBe(0);
  });

  test("delayed release publication times out truthfully, closes, and cannot publish late", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-release-timeout";
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-release-timeout"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setAtomicWriteDelay(100);
    const release = releaseOperationLock(harness.adapters, acquired.handle, { timeoutMs: 20 });
    let error: unknown;
    try {
      await runWithClockPump(harness, release, { stepMs: 5, maxSteps: 40 });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toEqual(expect.objectContaining({
      code: "lock_release_timeout",
      stage: "cleanup",
      boundMs: 20,
    }));
    expect(acquired.handle.state()).toEqual({
      descriptorOpen: false,
      leaseHeld: false,
      releasedMetadataWritten: false,
    });
    expect(harness.openLockDescriptorCount()).toBe(0);
    const recordAfterTimeout = JSON.parse(
      harness.files.get(ownerPath(home, "plugins-state")) ?? "null",
    );
    expect(recordAfterTimeout.state).toBe("held");
    harness.advanceMs(500);
    await Promise.resolve();
    expect(JSON.parse(harness.files.get(ownerPath(home, "plugins-state")) ?? "null"))
      .toEqual(recordAfterTimeout);
  });

  test.each(["lease-stat", "path-stat"] as const)(
    "delayed %s release observation reports the declared timeout and closes",
    async (delayedOperation) => {
      const harness = createFakeRuntimeHarness();
      const acquired = await acquireOperationLock({
        adapters: harness.adapters,
        explodexHome: `/tmp/explodex-release-delayed-${delayedOperation}`,
        resource: "plugins-state",
        identity: identity(harness, `op-release-delayed-${delayedOperation}`),
        waitBoundMs: 0,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      harness.setLockDelay(delayedOperation, 50);
      const release = acquired.handle.release({ timeoutMs: 20 });
      let error: unknown;
      try {
        await runWithClockPump(harness, release, { stepMs: 5, maxSteps: 40 });
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toEqual(expect.objectContaining({
        code: "lock_release_timeout",
        stage: "cleanup",
        boundMs: 20,
      }));
      expect(acquired.handle.state().descriptorOpen).toBe(false);
      expect(acquired.handle.state().leaseHeld).toBe(false);
      expect(harness.openLockDescriptorCount()).toBe(0);
    },
  );

  test("invalid and aborted release bounds close the descriptor unconditionally", async () => {
    for (const mode of ["invalid", "aborted"] as const) {
      const harness = createFakeRuntimeHarness();
      const acquired = await acquireOperationLock({
        adapters: harness.adapters,
        explodexHome: `/tmp/explodex-release-${mode}-bound`,
        resource: "plugins-state",
        identity: identity(harness, `op-release-${mode}-bound`),
        waitBoundMs: 0,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) continue;
      const abort = new AbortController();
      if (mode === "aborted") abort.abort();
      let error: unknown;
      try {
        await releaseOperationLock(harness.adapters, acquired.handle, {
          abortSignal: abort.signal,
          timeoutMs: mode === "invalid" ? Number.POSITIVE_INFINITY : 20,
        });
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toEqual(expect.objectContaining({
        code: mode === "invalid" ? "invalid_stage_bound" : "lock_release_interrupted",
        stage: "cleanup",
      }));
      expect(acquired.handle.state().descriptorOpen).toBe(false);
      expect(acquired.handle.state().leaseHeld).toBe(false);
      expect(harness.openLockDescriptorCount()).toBe(0);
    }
  });

  test("release generation mismatch and path substitution both close the descriptor", async () => {
    for (const mode of ["generation", "path"] as const) {
      const harness = createFakeRuntimeHarness();
      const home = `/tmp/explodex-release-${mode}`;
      const acquired = await acquireOperationLock({
        adapters: harness.adapters,
        explodexHome: home,
        resource: "plugins-state",
        identity: identity(harness, `op-${mode}`),
        waitBoundMs: 0,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) continue;
      if (mode === "generation") {
        harness.files.set(ownerPath(home, "plugins-state"), `${JSON.stringify({
          ...acquired.record,
          generation: "generation_replaced",
        })}\n`);
      } else {
        harness.replacePath(acquired.leasePath, { kind: "regular-file", mode: 0o600 });
      }
      await expect(acquired.handle.release()).rejects.toThrow();
      expect(acquired.handle.state().descriptorOpen).toBe(false);
      expect(harness.openLockDescriptorCount()).toBe(0);
    }
  });

  test("delayed descriptor close reports the release bound then converges without residue", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-delayed-close",
      resource: "plugins-state",
      identity: identity(harness, "op-delayed-close"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setLockDelay("lease-close", 100);
    const release = acquired.handle.release({ timeoutMs: 20 });
    let error: unknown;
    try {
      await runWithClockPump(harness, release, { stepMs: 5, maxSteps: 20 });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toEqual(expect.objectContaining({
      code: "lock_release_timeout",
      stage: "cleanup",
      boundMs: 20,
    }));
    expect(acquired.handle.state().descriptorOpen).toBe(true);
    expect(acquired.handle.state().leaseHeld).toBe(true);
    harness.advanceMs(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired.handle.state().descriptorOpen).toBe(false);
    expect(acquired.handle.state().leaseHeld).toBe(false);
    expect(harness.openLockDescriptorCount()).toBe(0);
  });

  test("release timeout plus close failure preserves structured bound and retryable residue", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-timeout-close-failure",
      resource: "plugins-state",
      identity: identity(harness, "op-timeout-close-failure"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setAtomicWriteDelay(100);
    harness.setLockFault("lease-close");
    const release = acquired.handle.release({ timeoutMs: 20 });
    let error: unknown;
    try {
      await runWithClockPump(harness, release, { stepMs: 5, maxSteps: 40 });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toEqual(expect.objectContaining({
      code: "lock_release_timeout",
      stage: "cleanup",
      boundMs: 20,
    }));
    expect(acquired.handle.state().descriptorOpen).toBe(true);
    expect(acquired.handle.state().leaseHeld).toBe(true);
    harness.setAtomicWriteDelay(0);
    await acquired.handle.release();
    expect(acquired.handle.state().descriptorOpen).toBe(false);
    expect(harness.openLockDescriptorCount()).toBe(0);
  });

  test("combined release publication and close failures retain truthful retryable residue", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-combined-release-failure",
      resource: "plugins-state",
      identity: identity(harness, "op-combined-release-failure"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setLockFault("atomic-write");
    harness.setLockFault("lease-close");
    await expect(acquired.handle.release()).rejects.toThrow(/Injected atomic write failure/);
    expect(acquired.handle.state().descriptorOpen).toBe(true);
    expect(acquired.handle.state().leaseHeld).toBe(true);
    expect(harness.openLockDescriptorCount()).toBe(1);
    await acquired.handle.release();
    expect(acquired.handle.state().descriptorOpen).toBe(false);
    expect(acquired.handle.state().leaseHeld).toBe(false);
    expect(harness.openLockDescriptorCount()).toBe(0);
  });

  test("descriptor close failure is reported as truthful lock residue", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-close-failure",
      resource: "plugins-state",
      identity: identity(harness, "op-close-failure"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setLockFault("lease-close");
    await expect(acquired.handle.release()).rejects.toThrow(/Injected lease close failure/);
    expect(acquired.handle.state().descriptorOpen).toBe(true);
    expect(harness.openLockDescriptorCount()).toBe(1);
    await acquired.handle.release();
    expect(acquired.handle.state().descriptorOpen).toBe(false);
    expect(acquired.handle.state().leaseHeld).toBe(false);
    expect(harness.openLockDescriptorCount()).toBe(0);
  });

  test("bounded contention and SIGINT leave no contender descriptor or late work", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-contended-timeout";
    const owner = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-owner"),
      waitBoundMs: 0,
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const abort = new AbortController();
    const pending = acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-interrupted"),
      waitBoundMs: 100,
      pollIntervalMs: 10,
      abortSignal: abort.signal,
    });
    harness.adapters.timers.setTimeout(() => abort.abort(), 25);
    const result = await runWithClockPump(harness, pending, { stepMs: 5, maxSteps: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("lock_interrupted");
    expect(result.stage).toBe("lock-acquisition");
    expect(typeof result.boundMs).toBe("number");
    expect(harness.openLockDescriptorCount()).toBe(1);
    await owner.handle.release();
    harness.advanceMs(1_000);
    expect(harness.openLockDescriptorCount()).toBe(0);
    expect(harness.heldLeaseCount()).toBe(0);
  });

  test.each([
    { waitBoundMs: Number.NaN },
    { waitBoundMs: Number.POSITIVE_INFINITY },
    { waitBoundMs: -1 },
    { waitBoundMs: 10, pollIntervalMs: 0 },
    { waitBoundMs: 10, pollIntervalMs: Number.POSITIVE_INFINITY },
  ])("rejects invalid lock timing configuration %#", async (timing) => {
    const harness = createFakeRuntimeHarness();
    const result = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-invalid-timing",
      resource: "plugins-state",
      identity: identity(harness, "op-invalid-timing"),
      ...timing,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_stage_bound");
  });

  test("parseOperationLockRecord accepts only complete schema-2 protocol records", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-parse-record",
      resource: "plugins-state",
      identity: identity(harness, "op-parse"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(parseOperationLockRecord(acquired.record)).toEqual(acquired.record);
    expect(parseOperationLockRecord({ ...acquired.record, schemaVersion: 1 })).toBe(null);
    expect(parseOperationLockRecord({ ...acquired.record, protocol: "legacy" })).toBe(null);
    await acquired.handle.release();
  });

  test("scope reports metadata release failure without claiming a closed lease remains held", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-scope-release-metadata-failure",
      resource: "plugins-state",
      identity: identity(harness, "op-scope-release-metadata-failure"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setLockFault("atomic-write");
    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "install",
      operationId: "op-scope-release-metadata-failure-runtime",
      run: async (ctx) => {
        ctx.scope.register({
          kind: "lock",
          label: "plugins-state",
          disposition: "command-owned",
          lockState: () => acquired.handle.state(),
          dispose: () => acquired.handle.release({ timeoutMs: 20 }),
        });
        return { locked: true };
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(result.residualInventory.locksHeld).toBe(0);
    expect(result.residualInventory.openLockDescriptors).toBe(0);
    expect(result.residualInventory.advisoryLeasesHeld).toBe(0);
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
  });

  test("bounded operation preserves a direct release timeout stage and bound", async () => {
    const harness = createFakeRuntimeHarness();
    const resultPromise = runBoundedOperation({
      adapters: harness.adapters,
      operation: "install",
      operationId: "op-direct-release-timeout",
      run: async () => {
        throw Object.assign(new Error("release timed out"), {
          code: "lock_release_timeout",
          stage: "cleanup",
          boundMs: 25,
        });
      },
    });
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("lock_release_timeout");
    expect(result.error.stage).toBe("cleanup");
    expect(result.error.boundMs).toBe(25);
  });

  test("resource-scope cleanup reports a real descriptor close failure", async () => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-scope-close-failure",
      resource: "plugins-state",
      identity: identity(harness, "op-scope-close-failure"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    harness.setLockFault("lease-close");
    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "install",
      operationId: "op-scope-close-failure-runtime",
      run: async (ctx) => {
        ctx.scope.register({
          kind: "lock",
          label: "plugins-state",
          disposition: "command-owned",
          lockState: () => acquired.handle.state(),
          dispose: () => acquired.handle.release(),
        });
        return { locked: true };
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cleanup_failed");
    expect(result.residualInventory.locksHeld).toBe(1);
    expect(result.residualInventory.openLockDescriptors).toBe(1);
    expect(result.residualInventory.advisoryLeasesHeld).toBe(1);
  });

  test("lock integrates with resource scope and leaves released metadata only", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-scope-lock";
    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "install",
      operationId: "op-scope-lock",
      run: async (ctx) => {
        const acquired = await acquireOperationLock({
          adapters: harness.adapters,
          explodexHome: home,
          resource: "plugins-state",
          identity: ctx.identity,
          waitBoundMs: 0,
        });
        if (!acquired.ok) throw new Error("lock failed");
        ctx.scope.register({
          kind: "lock",
          label: "plugins-state",
          disposition: "command-owned",
          lockState: () => acquired.handle.state(),
          dispose: () => acquired.handle.release(),
        });
        return { locked: true };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.residualInventory.locksHeld).toBe(0);
    expect(harness.openLockDescriptorCount()).toBe(0);
    expect(JSON.parse(harness.files.get(ownerPath(home, "plugins-state")) ?? "null").state)
      .toBe("released");
  });
});

describe("representative one-shot command simulation", () => {
  test("host-inspect style command completes without control plane residue", async () => {
    const harness = createFakeRuntimeHarness();
    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "host-inspect",
      operationId: "op-host-inspect",
      run: async (ctx) => {
        await ctx.runLocal("preflight", async () => undefined);
        ctx.markStageComplete("preflight");
        await ctx.runLocal("local-work", async () => {
          return { bundlePath: "/Applications/ChatGPT.app", build: "5628" };
        });
        ctx.markStageComplete("local-work");
        return { bundlePath: "/Applications/ChatGPT.app", build: "5628" };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.build).toBe("5628");
    expect(result.residualInventory.hasResidentControlPlane).toBe(false);
    expect(result.stagesCompleted).toEqual(["preflight", "local-work"]);
  });

  test("delayed observation after exit shows no reconnect activity", async () => {
    const harness = createFakeRuntimeHarness();
    let postExitActive = 0;

    const result = await runBoundedOperation({
      adapters: harness.adapters,
      operation: "status",
      operationId: "op-delayed",
      run: async (ctx) => {
        let reconnectArmed = true;
        ctx.scope.register({
          kind: "session",
          label: "read-only",
          disposition: "command-owned",
          dispose: () => {
            reconnectArmed = false;
          },
        });
        // Intentionally do not register a reconnect loop (forbidden).
        void reconnectArmed;
        return { ok: true };
      },
      afterDispose: (inventory) => {
        // Simulate delayed observation.
        harness.advanceMs(1_000);
        postExitActive = inventory.reconnectLoops + inventory.sessions + inventory.sockets;
      },
    });

    expect(result.ok).toBe(true);
    expect(postExitActive).toBe(0);
  });
});

describe("lock defect fixes (P1/P2/P3 audit)", () => {
  const ownerPath = (home: string, resource: "plugins-state" | "main-launch"): string =>
    `${lockPath(home, resource)}/owner.json`;
  const identity = (harness: ReturnType<typeof createFakeRuntimeHarness>, operationId: string) => ({
    operationId,
    operation: "test-operation",
    startedAt: harness.adapters.clock.nowIso(),
    ownerPid: harness.self.pid,
    ownerProcessStartedAt: harness.self.processStartedAt,
  });

  test("P1-1: real directory link count > 1 does not block acquisition", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-dir-linkcount";
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-dir-linkcount"),
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const containerStat = await harness.adapters.fs.statPath(lockPath(home, "plugins-state"));
    expect(containerStat.kind).toBe("directory");
    expect(containerStat.linkCount).toBeGreaterThanOrEqual(1);
    await acquired.handle.release();
  });

  test("P1-3: atomic container publication uses single rename and preserves canonical inode", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-atomic-pub";
    const first = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-atomic-first"),
      waitBoundMs: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stableInode = (await harness.adapters.fs.statPath(first.leasePath)).inode;
    await first.handle.release();

    const second = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-atomic-second"),
      waitBoundMs: 0,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const repeatedInode = (await harness.adapters.fs.statPath(second.leasePath)).inode;
    expect(repeatedInode).toBe(stableInode);
    await second.handle.release();
  });

  test("P2-7: legacy schema-1 owner record inside valid container fails closed", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-legacy-schema";
    const first = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-legacy-first"),
      waitBoundMs: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.handle.release();
    const legacyRecord = {
      schemaVersion: 1,
      protocol: "darwin-flock-v1",
      resource: "plugins-state",
      containerId: "legacy",
      state: "held",
      pid: 99999,
      processStartedAt: "2020-01-01T00:00:00.000Z",
    };
    harness.files.set(ownerPath(home, "plugins-state"), `${JSON.stringify(legacyRecord)}\n`);
    const result = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-legacy-contender"),
      waitBoundMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("lock_stale_unrecoverable");
  });

  test("P2-8: missing lease file (ENOENT) after container exists fails closed", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-missing-lease";
    const first = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-missing-first"),
      waitBoundMs: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.handle.release();
    const leaseFile = leasePath(home, "plugins-state");
    await harness.adapters.fs.removePrivateDirectory(leaseFile);
    const result = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-missing-contender"),
      waitBoundMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("lock_stale_unrecoverable");
  });

  test("P3-10: withOperationLock acquires, runs work, and releases", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-with-lock";
    const result = await withOperationLock(
      {
        adapters: harness.adapters,
        explodexHome: home,
        resource: "plugins-state",
        identity: identity(harness, "op-with-lock"),
        waitBoundMs: 0,
      },
      async (handle) => {
        expect(handle.state().descriptorOpen).toBe(true);
        expect(handle.state().leaseHeld).toBe(true);
        return { worked: true };
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ worked: true });
    expect(harness.openLockDescriptorCount()).toBe(0);
    expect(harness.heldLeaseCount()).toBe(0);
  });

  test("P3-10: withOperationLock returns failure result without running work", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-with-lock-busy";
    const owner = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-with-lock-owner"),
      waitBoundMs: 0,
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const result = await withOperationLock(
      {
        adapters: harness.adapters,
        explodexHome: home,
        resource: "plugins-state",
        identity: identity(harness, "op-with-lock-contender"),
        waitBoundMs: 0,
      },
      async () => ({ worked: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("lock_busy");
    expect(result.value).toBeUndefined();
    await owner.handle.release();
  });

  test("P2-5: lock failure result includes stage and boundMs", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-stage-bound";
    const owner = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-stage-bound-owner"),
      waitBoundMs: 0,
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const result = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: identity(harness, "op-stage-bound-contender"),
      waitBoundMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("lock-acquisition");
    expect(typeof result.boundMs).toBe("number");
    await owner.handle.release();
  });
});
