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
  parseOperationLockRecord,
  lockPath,
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

describe("operation locks (command-lifetime coordination)", () => {
  const ownerPath = (directory: string): string => `${directory}/owner.json`;
  test("exclusive acquire and release", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-a";
    const identity = {
      operationId: "op-lock-1",
      operation: "install",
      startedAt: harness.adapters.clock.nowIso(),
      ownerPid: harness.self.pid,
      ownerProcessStartedAt: harness.self.processStartedAt,
    };

    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity,
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.record.operationId).toBe("op-lock-1");
    expect(harness.files.has(ownerPath(lockPath(home, "plugins-state")))).toBe(true);

    const busy = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: { ...identity, operationId: "op-lock-2", ownerPid: 9002, ownerProcessStartedAt: "other" },
      waitBoundMs: 0,
    });
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.code).toBe("lock_busy");

    await releaseOperationLock(harness.adapters, acquired.path, acquired.record);
    expect(harness.files.has(ownerPath(lockPath(home, "plugins-state")))).toBe(false);

    const again = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: { ...identity, operationId: "op-lock-3" },
      waitBoundMs: 0,
    });
    expect(again.ok).toBe(true);
  });

  test("aborted acquisition never publishes its prepared lock", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-aborted-lock";
    const abort = new AbortController();
    const originalRenameExclusive = harness.adapters.fs.renameExclusive;
    harness.adapters.fs.renameExclusive = async (from, to, options) => {
      abort.abort();
      if (options?.abortSignal?.aborted) {
        throw Object.assign(new Error("rename aborted"), { code: "ABORT_ERR" });
      }
      return originalRenameExclusive(from, to, options);
    };

    await expect(acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: {
        operationId: "op-aborted-lock",
        operation: "install",
        startedAt: harness.adapters.clock.nowIso(),
        ownerPid: harness.self.pid,
        ownerProcessStartedAt: harness.self.processStartedAt,
      },
      waitBoundMs: 100,
      abortSignal: abort.signal,
    })).rejects.toThrow(/rename aborted/);

    expect(harness.files.has(ownerPath(lockPath(home, "plugins-state")))).toBe(false);
  });

  test("retries when a contended lock disappears before owner read", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-release-read-race";
    const path = lockPath(home, "plugins-state");
    const owner = {
      schemaVersion: 1 as const,
      resource: "plugins-state" as const,
      operationId: "op-releasing",
      pid: 12_390,
      processStartedAt: "live-owner",
      acquiredAt: "2026-07-01T00:00:01.000Z",
    };
    harness.setProcessAlive(owner.pid, owner.processStartedAt, true);
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    await harness.adapters.fs.createDirectoryExclusive(path);
    await harness.adapters.fs.writeFile(ownerPath(path), `${JSON.stringify(owner)}\n`);
    const originalReadText = harness.adapters.fs.readText;
    let releasedBeforeRead = false;
    harness.adapters.fs.readText = async (readPath) => {
      if (!releasedBeforeRead && readPath === ownerPath(path)) {
        releasedBeforeRead = true;
        harness.files.delete(ownerPath(path));
        await harness.adapters.fs.removeDirectory(path);
      }
      return originalReadText(readPath);
    };

    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: {
        operationId: "op-after-release",
        operation: "install",
        startedAt: harness.adapters.clock.nowIso(),
        ownerPid: harness.self.pid,
        ownerProcessStartedAt: harness.self.processStartedAt,
      },
      waitBoundMs: 100,
    });

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.record.operationId).toBe("op-after-release");
  });

  test("stale lock is recovered when owner is dead", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-stale";
    const deadPid = 12_345;
    const deadStart = "2026-07-01T00:00:00.000Z";
    harness.setProcessAlive(deadPid, deadStart, false);

    const path = lockPath(home, "main-launch");
    const stale = {
      schemaVersion: 1 as const,
      resource: "main-launch" as const,
      operationId: "op-dead",
      pid: deadPid,
      processStartedAt: deadStart,
      acquiredAt: "2026-07-01T00:00:01.000Z",
    };
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    await harness.adapters.fs.createDirectoryExclusive(path);
    await harness.adapters.fs.writeFile(ownerPath(path), `${JSON.stringify(stale)}\n`);

    const identity = {
      operationId: "op-recover",
      operation: "launch",
      startedAt: harness.adapters.clock.nowIso(),
      ownerPid: harness.self.pid,
      ownerProcessStartedAt: harness.self.processStartedAt,
    };

    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "main-launch",
      identity,
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.recoveredStale).toBe(true);
    expect(acquired.record.operationId).toBe("op-recover");
  });

  test("stale recovery does not unlink a replacement owner", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-stale-race";
    const path = lockPath(home, "main-launch");
    const stale = {
      schemaVersion: 1 as const,
      resource: "main-launch" as const,
      operationId: "op-dead",
      pid: 12_400,
      processStartedAt: "dead-start",
      acquiredAt: "2026-07-01T00:00:01.000Z",
    };
    const replacement = {
      schemaVersion: 1 as const,
      resource: "main-launch" as const,
      operationId: "op-replacement",
      pid: 12_401,
      processStartedAt: "replacement-start",
      acquiredAt: "2026-07-01T00:00:02.000Z",
    };
    harness.setProcessAlive(stale.pid, stale.processStartedAt, false);
    harness.setProcessAlive(replacement.pid, replacement.processStartedAt, true);
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    await harness.adapters.fs.createDirectoryExclusive(path);
    await harness.adapters.fs.writeFile(ownerPath(path), `${JSON.stringify(stale)}\n`);
    harness.setCompareRemoveBarrier(() => {
      harness.files.set(ownerPath(path), `${JSON.stringify(replacement)}\n`);
    });

    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "main-launch",
      identity: {
        operationId: "op-contender",
        operation: "launch",
        startedAt: harness.adapters.clock.nowIso(),
        ownerPid: harness.self.pid,
        ownerProcessStartedAt: harness.self.processStartedAt,
      },
      waitBoundMs: 0,
    });

    expect(acquired.ok).toBe(false);
    expect(JSON.parse(harness.files.get(ownerPath(path)) ?? "null")).toEqual(replacement);
  });

  test("release does not unlink a replacement owner", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-release-race";
    const path = lockPath(home, "plugins-state");
    const original = {
      schemaVersion: 1 as const,
      resource: "plugins-state" as const,
      operationId: "op-original",
      pid: harness.self.pid,
      processStartedAt: harness.self.processStartedAt,
      acquiredAt: "2026-07-01T00:00:01.000Z",
    };
    const replacement = {
      schemaVersion: 1 as const,
      resource: "plugins-state" as const,
      operationId: "op-replacement",
      pid: 12_500,
      processStartedAt: "replacement-start",
      acquiredAt: "2026-07-01T00:00:02.000Z",
    };
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    await harness.adapters.fs.createDirectoryExclusive(path);
    await harness.adapters.fs.writeFile(ownerPath(path), `${JSON.stringify(original)}\n`);
    harness.setCompareRemoveBarrier(() => {
      harness.files.set(ownerPath(path), `${JSON.stringify(replacement)}\n`);
    });

    await expect(releaseOperationLock(harness.adapters, path, original)).rejects.toThrow(
      /could not atomically remove/,
    );

    expect(JSON.parse(harness.files.get(ownerPath(path)) ?? "null")).toEqual(replacement);
  });

  test("release preserves an owned directory when unexpected entries block removal", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-extra-lock-entry";
    const path = lockPath(home, "plugins-state");
    const owner = {
      schemaVersion: 1 as const,
      resource: "plugins-state" as const,
      operationId: "op-extra-entry",
      pid: harness.self.pid,
      processStartedAt: harness.self.processStartedAt,
      acquiredAt: "2026-07-01T00:00:01.000Z",
    };
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    await harness.adapters.fs.createDirectoryExclusive(path);
    await harness.adapters.fs.writeFile(ownerPath(path), `${JSON.stringify(owner)}\n`);
    harness.addDirectoryEntry(`${path}/unexpected`);

    await expect(releaseOperationLock(harness.adapters, path, owner)).rejects.toThrow(
      /could not atomically remove/,
    );
    expect(harness.files.get(ownerPath(path))).toBe(`${JSON.stringify(owner)}\n`);
    expect(await harness.adapters.fs.isDirectory(path)).toBe(true);
  });

  test("release reports an ownerless lock directory instead of hiding residue", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-ownerless-lock";
    const path = lockPath(home, "plugins-state");
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    await harness.adapters.fs.createDirectoryExclusive(path);

    await expect(releaseOperationLock(harness.adapters, path, {
      schemaVersion: 1,
      resource: "plugins-state",
      operationId: "op-ownerless",
      pid: harness.self.pid,
      processStartedAt: harness.self.processStartedAt,
      acquiredAt: "2026-07-01T00:00:01.000Z",
    })).rejects.toThrow(/ENOENT/);
    expect(await harness.adapters.fs.exists(path)).toBe(true);
  });

  test("malformed lock fails closed without deletion", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-malformed-lock";
    const path = lockPath(home, "plugins-state");
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    await harness.adapters.fs.createDirectoryExclusive(path);
    await harness.adapters.fs.writeFile(ownerPath(path), "{partial");

    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: {
        operationId: "op-contender",
        operation: "install",
        startedAt: harness.adapters.clock.nowIso(),
        ownerPid: harness.self.pid,
        ownerProcessStartedAt: harness.self.processStartedAt,
      },
      waitBoundMs: 0,
    });

    expect(acquired.ok).toBe(false);
    if (acquired.ok) return;
    expect(acquired.code).toBe("lock_stale_unrecoverable");
    expect(harness.files.get(ownerPath(path))).toBe("{partial");
  });

  test.each([
    { waitBoundMs: Number.NaN },
    { waitBoundMs: Number.POSITIVE_INFINITY },
    { waitBoundMs: -1 },
    { waitBoundMs: 10, pollIntervalMs: 0 },
    { waitBoundMs: 10, pollIntervalMs: Number.POSITIVE_INFINITY },
  ])("rejects invalid lock timing configuration %#", async (timing) => {
    const harness = createFakeRuntimeHarness();
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: "/tmp/explodex-invalid-lock-timing",
      resource: "plugins-state",
      identity: {
        operationId: "op-invalid-lock-timing",
        operation: "install",
        startedAt: harness.adapters.clock.nowIso(),
        ownerPid: harness.self.pid,
        ownerProcessStartedAt: harness.self.processStartedAt,
      },
      ...timing,
    });

    expect(acquired.ok).toBe(false);
    if (acquired.ok) return;
    expect(acquired.code).toBe("invalid_stage_bound");
  });

  test("hardened and legacy clients contend on the same canonical path", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-legacy-contention";
    const path = lockPath(home, "plugins-state");
    expect(path.endsWith("/plugins-state.lock")).toBe(true);
    const legacy = {
      schemaVersion: 1 as const,
      resource: "plugins-state" as const,
      operationId: "op-legacy",
      pid: 12_700,
      processStartedAt: "legacy-start",
      acquiredAt: "2026-07-01T00:00:01.000Z",
    };
    await harness.adapters.fs.mkdir(`${home}/locks`, { recursive: true });
    expect(await harness.adapters.fs.writeFileExclusive(path, `${JSON.stringify(legacy)}\n`)).toBe(true);

    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: {
        operationId: "op-hardened",
        operation: "install",
        startedAt: harness.adapters.clock.nowIso(),
        ownerPid: harness.self.pid,
        ownerProcessStartedAt: harness.self.processStartedAt,
      },
      waitBoundMs: 0,
    });

    expect(acquired.ok).toBe(false);
    if (acquired.ok) return;
    expect(acquired.code).toBe("lock_stale_unrecoverable");
    expect(await harness.adapters.fs.isFile(path)).toBe(true);
    expect(await harness.adapters.fs.isDirectory(path)).toBe(false);
  });

  test("legacy exclusive creation cannot acquire while a hardened directory owns the path", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-hardened-contention";
    const acquired = await acquireOperationLock({
      adapters: harness.adapters,
      explodexHome: home,
      resource: "plugins-state",
      identity: {
        operationId: "op-hardened-owner",
        operation: "install",
        startedAt: harness.adapters.clock.nowIso(),
        ownerPid: harness.self.pid,
        ownerProcessStartedAt: harness.self.processStartedAt,
      },
      waitBoundMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    expect(await harness.adapters.fs.writeFileExclusive(
      acquired.path,
      "legacy replacement",
    )).toBe(false);
    expect(await harness.adapters.fs.isDirectory(acquired.path)).toBe(true);
  });

  test("parseOperationLockRecord rejects malformed records", () => {
    expect(parseOperationLockRecord(null)).toBe(null);
    expect(parseOperationLockRecord({ schemaVersion: 2 })).toBe(null);
    expect(
      parseOperationLockRecord({
        schemaVersion: 1,
        resource: "plugins-state",
        operationId: "x",
        pid: 1,
        processStartedAt: "t",
        acquiredAt: "t2",
      }),
    ).not.toBe(null);
  });

  test("lock integrates with resource scope dispose", async () => {
    const harness = createFakeRuntimeHarness();
    const home = "/tmp/explodex-test-home-scope-lock";

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
        expect(acquired.ok).toBe(true);
        if (!acquired.ok) throw new Error("lock failed");
        ctx.scope.register({
          kind: "lock",
          label: "plugins-state",
          disposition: "command-owned",
          dispose: async (control) => {
            await releaseOperationLock(harness.adapters, acquired.path, acquired.record, {
              abortSignal: control.signal,
            });
          },
        });
        return { locked: true };
      },
    });

    expect(result.ok).toBe(true);
    expect(harness.files.has(ownerPath(lockPath(home, "plugins-state")))).toBe(false);
    if (!result.ok) return;
    expect(result.residualInventory.locksHeld).toBe(0);
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
