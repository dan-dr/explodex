import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createInitialDevInstanceState,
  describeDevLayout,
  evaluateDevOwnership,
  guardDevMutation,
  inspectDevInstanceStatus,
  recoverDevInstance,
  resolveDevRootSelection,
  validateDevRootSelection,
  withDevInstanceLock,
  type DevInstanceState,
  type DevOwnershipEvidence,
  type DevOwnershipFailureCode,
  type DevStatusSnapshot,
} from "../../src/dev/index.ts";
import type { HostIdentity } from "../../src/host/types.ts";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  createFixtureAdapters,
  MemoryFileSystem,
} from "../host/fixture-fs.ts";
import type {
  ReadOnlyCommandRunner,
} from "../../src/host/process-adapters.ts";
import type { RuntimeProcess } from "../../src/runtime/adapters.ts";
import type { CdpAdapter } from "../../src/cdp/adapters.ts";
import {
  stopExactProcess,
} from "../../src/dev/phase0-operation.ts";
import { createFakeRuntimeHarness } from "../runtime/fixture-runtime.ts";

const HOST: HostIdentity = {
  bundlePath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleId: "com.openai.codex",
  executableName: "ChatGPT",
  signingTeam: "2DC432GLL2",
  appVersion: "26.721.41059",
  appBuild: "5848",
  hostHashes: {
    "Contents/Info.plist": "a".repeat(64),
    "Contents/MacOS/ChatGPT": "b".repeat(64),
  },
};

const TARGET: TargetIdentity = {
  role: "development",
  pid: 4242,
  processStartedAt: "2026-07-27T12:00:00.000001Z",
  executablePath: HOST.executablePath,
  appVersion: HOST.appVersion,
  appBuild: HOST.appBuild,
  port: 9444,
  browserIdentity: "Chrome/ChatGPT",
  targetId: "target-dev",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 17,
  executionContextUniqueId: "context-dev",
  frameId: "frame-dev",
};

function readyState(root = "/tmp/explodex-dev"): DevInstanceState {
  const state = createInitialDevInstanceState({
    layout: describeDevLayout(root),
    appPath: HOST.bundlePath,
    executablePath: HOST.executablePath,
    launchMarker: "--explodex-dev-instance=plugin-dev",
    frozenHost: HOST,
    updatedAt: "2026-07-27T12:00:01.000Z",
  });
  return {
    ...state,
    status: "ready",
    pid: TARGET.pid,
    processStartedAt: TARGET.processStartedAt,
    targetId: TARGET.targetId,
    browserIdentity: TARGET.browserIdentity,
    executionContextId: TARGET.executionContextId,
    executionContextUniqueId: TARGET.executionContextUniqueId,
    frameId: TARGET.frameId,
    appVersion: HOST.appVersion,
    appBuild: HOST.appBuild,
    startedAt: "2026-07-27T12:00:00.000Z",
  };
}

function validEvidence(
  overrides: Partial<DevOwnershipEvidence> = {},
): DevOwnershipEvidence {
  const state = readyState();
  return {
    requestedRoot: state.rootPath,
    stateLoadStatus: "valid",
    state,
    currentHost: HOST,
    phase0: {
      status: "proven",
      frozenHost: HOST,
      markerValue: state.launchMarker,
    },
    process: {
      pid: state.pid!,
      parentPid: 1,
      executablePath: state.executablePath,
      arguments: [state.executablePath, state.launchMarker],
    },
    currentPidIdentity: {
      pid: state.pid!,
      processStartedAt: state.processStartedAt!,
    },
    paths: {
      ok: true,
      canonicalRoot: state.rootPath,
      failures: [],
    },
    listeners: [{
      pid: state.pid!,
      processStartedAt: state.processStartedAt,
      host: "127.0.0.1",
      port: 9444,
      family: "ipv4",
    }],
    endpoint: {
      kind: "available",
      target: TARGET,
      targets: [{
        id: TARGET.targetId,
        type: TARGET.targetType,
        url: TARGET.targetUrl,
      }],
    },
    compatibility: {
      status: "proven",
      matched: true,
      reason: null,
    },
    protectedMainOverlap: false,
    ...overrides,
  };
}

describe("M4 development root selection", () => {
  test("one explicit override reuses the canonical layout", async () => {
    const fs = new MemoryFileSystem();
    const selection = resolveDevRootSelection({
      osHome: "/Users/tester",
      explodexHome: "/Users/tester/.explodex",
      explicitRoot: "/tmp/isolated-dev",
    });
    const validation = await validateDevRootSelection({
      fs,
      selection,
      existingState: null,
      stateLoadStatus: "absent",
      protectedPaths: {
        mainProfilePaths: [
          "/Users/tester/Library/Application Support/ChatGPT",
          "/Users/tester/Library/Application Support/Codex",
        ],
        userCodexHome: "/Users/tester/.codex",
        explodexHome: "/Users/tester/.explodex",
      },
    });
    expect(validation.ok).toBe(true);
    expect(selection.rootPath).toBe("/tmp/isolated-dev");
    expect(describeDevLayout(selection.rootPath).statePath).toBe(
      "/tmp/isolated-dev/state.json",
    );
  });

  test("rejects protected, aliased, and nonempty unowned overrides without fallback", async () => {
    const cases = [
      "/Users/tester/.codex",
      "/Users/tester/.explodex/plugins",
      "/Users/tester/Library/Application Support/ChatGPT",
    ];
    for (const root of cases) {
      const fs = new MemoryFileSystem();
      const selection = resolveDevRootSelection({
        osHome: "/Users/tester",
        explodexHome: "/Users/tester/.explodex",
        explicitRoot: root,
      });
      const result = await validateDevRootSelection({
        fs,
        selection,
        existingState: null,
        stateLoadStatus: "absent",
        protectedPaths: {
          mainProfilePaths: [
            "/Users/tester/Library/Application Support/ChatGPT",
          ],
          userCodexHome: "/Users/tester/.codex",
          explodexHome: "/Users/tester/.explodex",
        },
      });
      expect(result.ok).toBe(false);
      expect(selection.rootPath).toBe(root);
    }

    const aliasFs = new MemoryFileSystem();
    aliasFs.seedDir("/tmp/real-dev");
    aliasFs.seedSymlink("/tmp/alias-dev", "/tmp/real-dev");
    const aliasSelection = resolveDevRootSelection({
      osHome: "/Users/tester",
      explicitRoot: "/tmp/alias-dev",
    });
    const alias = await validateDevRootSelection({
      fs: aliasFs,
      selection: aliasSelection,
      existingState: null,
      stateLoadStatus: "absent",
      protectedPaths: {},
    });
    expect(alias.ok).toBe(false);
    if (!alias.ok) expect(alias.code).toBe("root_symlink");

    const nonemptyFs = new MemoryFileSystem();
    nonemptyFs.seedDir("/tmp/nonempty-dev");
    nonemptyFs.seedFile("/tmp/nonempty-dev/user.txt", "owned by user");
    const nonemptySelection = resolveDevRootSelection({
      osHome: "/Users/tester",
      explicitRoot: "/tmp/nonempty-dev",
    });
    const nonempty = await validateDevRootSelection({
      fs: nonemptyFs,
      selection: nonemptySelection,
      existingState: null,
      stateLoadStatus: "absent",
      protectedPaths: {},
    });
    expect(nonempty.ok).toBe(false);
    if (!nonempty.ok) expect(nonempty.code).toBe("nonempty_unowned_root");
  });
});

describe("exact development ownership matrix", () => {
  test("accepts only the complete current canonical host/process/endpoint/target identity", () => {
    const result = evaluateDevOwnership({
      operation: "inject",
      evidence: validEvidence(),
    });
    expect(result.owned).toBe(true);
    expect(result.mutationAllowed).toBe(true);
    expect(result.observedStatus).toBe("ready");
    expect(result.failures).toEqual([]);
  });

  test("every failed predicate blocks all lifecycle and renderer effects", () => {
    const failures: Array<
      [DevOwnershipFailureCode, Partial<DevOwnershipEvidence>]
    > = [
      ["state_root_mismatch", { requestedRoot: "/tmp/other-root" }],
      ["pid_start_mismatch", {
        currentPidIdentity: {
          pid: TARGET.pid,
          processStartedAt: "reused-start",
        },
      }],
      ["host_build_mismatch", {
        currentHost: { ...HOST, appBuild: "9999" },
      }],
      ["marker_mismatch", {
        process: {
          ...validEvidence().process!,
          arguments: [HOST.executablePath, "--explodex-dev-instance=other"],
        },
      }],
      ["path_alias", {
        paths: {
          ok: false,
          canonicalRoot: "/tmp/elsewhere",
          failures: ["root_alias"],
        },
      }],
      ["foreign_9444_owner", {
        listeners: [{
          pid: 9999,
          processStartedAt: "foreign",
          host: "127.0.0.1",
          port: 9444,
          family: "ipv4",
        }],
      }],
      ["context_drift", {
        endpoint: {
          kind: "available",
          target: { ...TARGET, executionContextUniqueId: "replacement" },
          targets: [{
            id: TARGET.targetId,
            type: TARGET.targetType,
            url: TARGET.targetUrl,
          }],
        },
      }],
      ["main_overlap", { protectedMainOverlap: true }],
      ["compatibility_unproven", {
        compatibility: {
          status: "unproven",
          matched: false,
          reason: "no_record",
        },
      }],
    ];

    for (const [expectedCode, override] of failures) {
      const assessment = evaluateDevOwnership({
        operation: "inject",
        evidence: validEvidence(override),
      });
      const calls = {
        launch: 0,
        signal: 0,
        promote: 0,
        evaluate: 0,
        fallback: 0,
      };
      const guarded = guardDevMutation({
        assessment,
        effects: {
          launch: () => { calls.launch += 1; },
          signal: () => { calls.signal += 1; },
          promote: () => { calls.promote += 1; },
          evaluate: () => { calls.evaluate += 1; },
          fallback: () => { calls.fallback += 1; },
        },
        run: () => "should-not-run",
      });
      expect(guarded.ok).toBe(false);
      expect(assessment.failures.map((failure) => failure.code)).toContain(
        expectedCode,
      );
      expect(calls).toEqual({
        launch: 0,
        signal: 0,
        promote: 0,
        evaluate: 0,
        fallback: 0,
      });
    }
  });

  test("missing state never adopts a ChatGPT-looking 9444 process", () => {
    const evidence = validEvidence({
      stateLoadStatus: "absent",
      state: null,
    });
    const assessment = evaluateDevOwnership({
      operation: "stop",
      evidence,
    });
    expect(assessment.owned).toBe(false);
    expect(assessment.failures.map((failure) => failure.code)).toContain(
      "state_missing_foreign_process",
    );
  });
});

describe("read-only status and explicit recovery", () => {
  test("status inventories an absent root without creating or rewriting anything", async () => {
    const fixture = createFixtureAdapters({});
    const writesBefore = [...fixture.fs.writeLog];
    const status = await inspectDevInstanceStatus({
      osHome: "/Users/tester",
      explodexHome: "/Users/tester/.explodex",
      explicitRoot: "/tmp/read-only-dev",
      hostAdapters: fixture.adapters,
      statusAdapters: {
        process: {
          async list() {
            return [];
          },
          async identify() {
            return null;
          },
        },
        port: {
          async listenersFor() {
            return [];
          },
        },
      },
      cdp: {
        async readEndpoint() {
          throw new Error("status must not query an unowned endpoint");
        },
        async listTargets() {
          throw new Error("status must not query an unowned endpoint");
        },
        async openTargetSession() {
          throw new Error("status must not open an unowned endpoint");
        },
      },
    });
    expect(status.readOnly).toBe(true);
    expect(status.assessment.observedStatus).toBe("stopped");
    expect(status.activity).toEqual({
      launched: false,
      signaled: false,
      evaluated: false,
      wroteState: false,
      fellBack: false,
    });
    expect(fixture.fs.writeLog).toEqual(writesBefore);
    expect(await fixture.fs.exists("/tmp/read-only-dev")).toBe(false);
  });

  test("status preserves malformed state bytes and reports it as non-ready", async () => {
    const fixture = createFixtureAdapters({});
    const root = "/tmp/malformed-status-dev";
    const statePath = join(root, "state.json");
    fixture.fs.seedFile(statePath, "{not-json\n");
    const writesBefore = [...fixture.fs.writeLog];
    const bytesBefore = await fixture.fs.readFile(statePath);
    const status = await inspectDevInstanceStatus({
      osHome: "/Users/tester",
      explodexHome: "/Users/tester/.explodex",
      explicitRoot: root,
      hostAdapters: fixture.adapters,
      statusAdapters: {
        process: {
          async list() {
            return [];
          },
          async identify() {
            return null;
          },
        },
        port: {
          async listenersFor() {
            return [];
          },
        },
      },
      cdp: {
        async readEndpoint() {
          throw new Error("malformed state grants no endpoint authority");
        },
        async listTargets() {
          throw new Error("malformed state grants no endpoint authority");
        },
        async openTargetSession() {
          throw new Error("malformed state grants no endpoint authority");
        },
      },
    });
    expect(status.stateLoadStatus).toBe("malformed");
    expect(status.assessment.observedStatus).toBe("stale");
    expect(status.assessment.owned).toBe(false);
    expect(await fixture.fs.readFile(statePath)).toEqual(bytesBefore);
    expect(fixture.fs.writeLog).toEqual(writesBefore);
  });

  test("status assessment never promotes stale ready state", () => {
    const state = readyState();
    const assessment = evaluateDevOwnership({
      operation: "status",
      evidence: validEvidence({
        currentPidIdentity: {
          pid: state.pid!,
          processStartedAt: "reused-start",
        },
      }),
    });
    expect(assessment.recordedStatus).toBe("ready");
    expect(assessment.observedStatus).toBe("stale");
    expect(assessment.mutationAllowed).toBe(false);
  });

  test("recover clears independently dead state and retains bounded diagnostics", async () => {
    const root = "/tmp/recover-dead";
    const failed = {
      ...readyState(root),
      status: "failed" as const,
      lastError: {
        code: "launch_partial",
        message: "partial launch",
        phase: "readiness",
      },
    };
    const snapshot: DevStatusSnapshot = {
      rootPath: root,
      stateLoadStatus: "valid",
      state: failed,
      assessment: evaluateDevOwnership({
        operation: "recover",
        evidence: validEvidence({
          requestedRoot: root,
          state: failed,
          paths: {
            ok: true,
            canonicalRoot: root,
            failures: [],
          },
          process: null,
          currentPidIdentity: null,
          listeners: [],
          endpoint: null,
        }),
      }),
      readOnly: true,
      activity: {
        launched: false,
        signaled: false,
        evaluated: false,
        wroteState: false,
        fellBack: false,
      },
    };
    const runtime = createFakeRuntimeHarness();
    const saved: DevInstanceState[] = [];
    let terminateCalls = 0;
    const result = await recoverDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot,
      saveState: async (state) => { saved.push(state); },
      terminate: async () => {
        terminateCalls += 1;
        return {
          ok: true,
          confirmedExit: true,
          method: "browser-close-only",
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(terminateCalls).toBe(0);
    expect(saved[0]?.status).toBe("stopped");
    expect(saved[0]?.pid).toBeNull();
    expect(saved[0]?.recoveryDiagnostics).toHaveLength(1);
    expect(saved[0]?.recoveryDiagnostics[0]?.priorPid).toBe(TARGET.pid);
    expect(runtime.openLockDescriptorCount()).toBe(0);
    expect(runtime.heldLeaseCount()).toBe(0);
  });

  test("recover terminates only a fully owned live partial process", async () => {
    const root = "/tmp/recover-live";
    const failed = {
      ...readyState(root),
      status: "failed" as const,
      lastError: {
        code: "state_commit_failed",
        message: "ready commit failed",
        phase: "state-write",
      },
    };
    const evidence = validEvidence({
      requestedRoot: root,
      state: failed,
      paths: {
        ok: true,
        canonicalRoot: root,
        failures: [],
      },
    });
    const snapshot: DevStatusSnapshot = {
      rootPath: root,
      stateLoadStatus: "valid",
      state: failed,
      assessment: evaluateDevOwnership({
        operation: "recover",
        evidence,
      }),
      readOnly: true,
      activity: {
        launched: false,
        signaled: false,
        evaluated: false,
        wroteState: false,
        fellBack: false,
      },
    };
    const runtime = createFakeRuntimeHarness();
    const saved: DevInstanceState[] = [];
    let terminateCalls = 0;
    const result = await recoverDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot,
      saveState: async (state) => { saved.push(state); },
      terminate: async () => {
        terminateCalls += 1;
        return {
          ok: true,
          confirmedExit: true,
          method: "browser-close-then-signal",
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(terminateCalls).toBe(1);
    expect(saved[0]?.status).toBe("stopped");
  });

  test("recover refuses uncertain ownership and preserves state/process disposition", async () => {
    const root = "/tmp/recover-refuse";
    const failed = {
      ...readyState(root),
      status: "failed" as const,
    };
    const snapshot: DevStatusSnapshot = {
      rootPath: root,
      stateLoadStatus: "valid",
      state: failed,
      assessment: evaluateDevOwnership({
        operation: "recover",
        evidence: validEvidence({
          requestedRoot: root,
          state: failed,
          listeners: [{
            pid: 9999,
            processStartedAt: "foreign",
            host: "127.0.0.1",
            port: 9444,
            family: "ipv4",
          }],
        }),
      }),
      readOnly: true,
      activity: {
        launched: false,
        signaled: false,
        evaluated: false,
        wroteState: false,
        fellBack: false,
      },
    };
    const runtime = createFakeRuntimeHarness();
    let writes = 0;
    let terminations = 0;
    const result = await recoverDevInstance({
      rootPath: root,
      runtimeAdapters: runtime.adapters,
      readStatus: async () => snapshot,
      saveState: async () => { writes += 1; },
      terminate: async () => {
        terminations += 1;
        return {
          ok: true,
          confirmedExit: true,
          method: "browser-close-only",
        };
      },
    });
    expect(result.ok).toBe(false);
    expect(writes).toBe(0);
    expect(terminations).toBe(0);
  });
});

describe("same-instance bounded locking", () => {
  test("serializes transitions on the stable root lock and closes descriptors", async () => {
    const runtime = createFakeRuntimeHarness();
    const root = "/tmp/locked-dev";
    const first = await withDevInstanceLock({
      rootPath: root,
      operation: "dev.recover",
      runtimeAdapters: runtime.adapters,
      work: async () => "first",
    });
    expect(first.ok).toBe(true);
    expect(runtime.files.has(join(root, "locks", "dev-instance.lock", "lease"))).toBe(
      true,
    );
    expect(runtime.openLockDescriptorCount()).toBe(0);
    expect(runtime.heldLeaseCount()).toBe(0);
  });

  test("returns bounded busy and never breaks a contended lease from metadata", async () => {
    const runtime = createFakeRuntimeHarness();
    const root = "/tmp/busy-dev";
    const first = await withDevInstanceLock({
      rootPath: root,
      operation: "dev.recover",
      runtimeAdapters: runtime.adapters,
      work: async () => "initialize",
    });
    expect(first.ok).toBe(true);
    const lease = join(root, "locks", "dev-instance.lock", "lease");
    runtime.setLeaseBusy(lease, true);
    const contender = withDevInstanceLock({
      rootPath: root,
      operation: "dev.stop",
      runtimeAdapters: runtime.adapters,
      waitBoundMs: 0,
      work: async () => "must-not-run",
    });
    const result = await contender;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("dev.instance-busy");
    expect(runtime.openLockDescriptorCount()).toBe(0);
  });

  test("recovers dead held metadata only after a free lease, and rejects live-owner/free-lease", async () => {
    const runtime = createFakeRuntimeHarness();
    const root = "/tmp/stale-lock-dev";
    const initialized = await withDevInstanceLock({
      rootPath: root,
      operation: "dev.recover",
      runtimeAdapters: runtime.adapters,
      work: async () => "initialized",
    });
    expect(initialized.ok).toBe(true);
    const ownerPath = join(
      root,
      "locks",
      "dev-instance.lock",
      "owner.json",
    );
    const released = JSON.parse(runtime.files.get(ownerPath) ?? "{}") as Record<
      string,
      unknown
    >;
    const held = {
      ...released,
      state: "held",
      operationId: "crashed-owner",
      generation: "crashed-generation",
      pid: 7007,
      processStartedAt: "7007-start",
      acquiredAt: "2026-07-27T12:00:00.000Z",
      releasedAt: null,
    };
    runtime.replacePath(ownerPath, {
      kind: "regular-file",
      mode: 0o600,
      uid: 501,
      device: "1",
      inode: "9001",
      linkCount: 1,
      text: `${JSON.stringify(held, null, 2)}\n`,
    });
    runtime.setProcessAlive(7007, "7007-start", false);
    const recovered = await withDevInstanceLock({
      rootPath: root,
      operation: "dev.stop",
      runtimeAdapters: runtime.adapters,
      work: async () => "recovered",
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.recoveredStale).toBe(true);

    const current = JSON.parse(runtime.files.get(ownerPath) ?? "{}") as Record<
      string,
      unknown
    >;
    runtime.replacePath(ownerPath, {
      kind: "regular-file",
      mode: 0o600,
      uid: 501,
      device: "1",
      inode: "9002",
      linkCount: 1,
      text: `${JSON.stringify({
        ...current,
        state: "held",
        operationId: "live-owner",
        generation: "live-generation",
        pid: 8008,
        processStartedAt: "8008-start",
        acquiredAt: "2026-07-27T12:01:00.000Z",
        releasedAt: null,
      }, null, 2)}\n`,
    });
    runtime.setProcessAlive(8008, "8008-start", true);
    const invariant = await withDevInstanceLock({
      rootPath: root,
      operation: "dev.restart",
      runtimeAdapters: runtime.adapters,
      work: async () => "must-not-run",
    });
    expect(invariant.ok).toBe(false);
    if (!invariant.ok) {
      expect(invariant.code).toBe("dev.lock-failed");
      expect(invariant.details.lockCode).toBe("lock_invariant_violation");
    }
    expect(runtime.openLockDescriptorCount()).toBe(0);
    expect(runtime.heldLeaseCount()).toBe(0);
  });
});

describe("strict recovery termination", () => {
  function terminationFixture(options: {
    listeners: number[];
    endpointFails?: boolean;
    targetId?: string;
    contextUniqueId?: string;
  }): {
    runtimeProcess: RuntimeProcess;
    commands: ReadOnlyCommandRunner;
    cdp: CdpAdapter;
    signals: string[];
  } {
    let alive = true;
    const signals: string[] = [];
    const runtimeProcess: RuntimeProcess = {
      self() {
        return { pid: 9999, processStartedAt: "self-start" };
      },
      async identify(pid) {
        return alive && pid === 4242
          ? { pid, processStartedAt: "4242-start" }
          : null;
      },
      async isAlive(pid, processStartedAt) {
        return (
          alive &&
          pid === 4242 &&
          processStartedAt === "4242-start"
        );
      },
      async signalExact(_identity, signal) {
        signals.push(signal);
        alive = false;
        return true;
      },
    };
    const commands: ReadOnlyCommandRunner = {
      async exec(file) {
        if (file === "/bin/ps") {
          return {
            stdout:
              "4242 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --explodex-instance=plugin-dev\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (file === "/usr/sbin/lsof") {
          if (!alive) return { stdout: "", stderr: "", exitCode: 1 };
          return {
            stdout: options.listeners
              .map((pid) => `p${pid}\nn127.0.0.1:9444`)
              .join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`unexpected command ${file}`);
      },
    };
    const cdp: CdpAdapter = {
      async readEndpoint() {
        if (options.endpointFails) throw new Error("endpoint unavailable");
        return {
          browser: "Chrome/1",
          protocolVersion: "1.3",
          webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/browser/test",
          pid: 4242,
        };
      },
      async listTargets() {
        return [
          {
            id: options.targetId ?? "target-1",
            type: "page",
            title: "ChatGPT",
            url: "app://-/index.html",
          },
        ];
      },
      async openTargetSession({ target }) {
        return {
          targetId: target.id,
          isOpen() {
            return true;
          },
          async listExecutionContexts() {
            return [
              {
                id: 11,
                uniqueId:
                  options.contextUniqueId ?? "context-1",
                targetId: target.id,
                frameId: "frame-1",
                isDefault: true,
                origin: "app://-",
                name: "",
              },
            ];
          },
          async evaluate() {
            return { value: true };
          },
          async close() {},
        };
      },
    };
    return { runtimeProcess, commands, cdp, signals };
  }

  test("co-owned listener and target drift cause zero signal", async () => {
    for (const testCase of [
      { listeners: [4242, 4343], targetId: "target-1" },
      { listeners: [4242], targetId: "replacement-target" },
      {
        listeners: [4242],
        targetId: "target-1",
        contextUniqueId: "replacement-context",
      },
    ]) {
      const fixture = terminationFixture(testCase);
      const result = await stopExactProcess({
        runtimeProcess: fixture.runtimeProcess,
        commands: fixture.commands,
        cdp: fixture.cdp,
        pid: 4242,
        processStartedAt: "4242-start",
        executablePath:
          "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        marker: "--explodex-instance=plugin-dev",
        timeoutMs: 50,
        pollMs: 1,
        expectedTargetId: "target-1",
        expectedContextUniqueId: "context-1",
        requireCompleteEndpointOwnershipForSignal: true,
      });
      expect(result.stopped).toBe(false);
      expect(result.uncertain).toBe(true);
      expect(fixture.signals).toEqual([]);
    }
  });

  test("endpoint failure may fall back to the still-exact PID", async () => {
    const fixture = terminationFixture({
      listeners: [4242],
      endpointFails: true,
    });
    const result = await stopExactProcess({
      runtimeProcess: fixture.runtimeProcess,
      commands: fixture.commands,
      cdp: fixture.cdp,
      pid: 4242,
      processStartedAt: "4242-start",
      executablePath:
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      marker: "--explodex-instance=plugin-dev",
      timeoutMs: 50,
      pollMs: 1,
      expectedTargetId: "target-1",
      requireCompleteEndpointOwnershipForSignal: true,
    });
    expect(result).toMatchObject({
      stopped: true,
      portReleased: true,
      uncertain: false,
      method: "exact-signal-only",
    });
    expect(fixture.signals).toEqual(["SIGTERM"]);
  });
});
