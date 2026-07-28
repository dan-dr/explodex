import { describe, expect, test } from "bun:test";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  createStagedMainArtifactReceipt,
} from "../../src/dev/main-staging.ts";
import {
  runMainApplyOperation,
  type MainApplyAdapters,
  type PreparedMainApplyTarget,
} from "../../src/host/main-apply.ts";
import { authorizeMainApplyCheckpoint } from "../../src/commands/main-apply.ts";
import type { GenerationRecord } from "../../src/plugin/generation.ts";
import type { PluginPayloadSnapshot } from "../../src/plugin/approval-transaction.ts";

const MAIN_TARGET: TargetIdentity = {
  role: "main",
  pid: 701,
  processStartedAt: "2026-07-28T02:00:00.000000Z",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  appVersion: "26.800.1",
  appBuild: "6001",
  port: 9333,
  browserIdentity: "Chrome/140",
  targetId: "main-target",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 21,
  executionContextUniqueId: "main-context",
  frameId: "main-frame",
};

const DEV_TARGET: TargetIdentity = {
  ...MAIN_TARGET,
  role: "development",
  pid: 601,
  processStartedAt: "2026-07-28T01:00:00.000000Z",
  port: 9444,
  targetId: "dev-target",
  executionContextId: 11,
  executionContextUniqueId: "dev-context",
  frameId: "dev-frame",
};

const GENERATION: GenerationRecord = {
  schemaVersion: 1,
  generationId: "generation-main",
  pluginId: "safe-main",
  version: "opaque-1",
  mapMode: "required",
  sdkInput: {
    kind: "publishable",
    version: "1.2.0",
    runtimeSha256: "a".repeat(64),
  },
  inputDigests: { "src/index.ts": "b".repeat(64) },
  outputDigests: {
    "index.js": "c".repeat(64),
    "index.js.map": "d".repeat(64),
    "plugin.json": "e".repeat(64),
    "checksums.json": "f".repeat(64),
  },
  payloadSha256: "1".repeat(64),
};

const SNAPSHOT = {
  identity: {
    id: "safe-main",
    version: "opaque-1",
    payloadSha256: "1".repeat(64),
  },
  manifest: {
    schemaVersion: 1,
    id: "safe-main",
    version: "opaque-1",
    displayName: "Safe main",
    description: "Main apply fixture",
    sdkRange: "^1.2.0",
    lifecycle: "dynamic",
    entry: "index.js",
    assets: [],
  },
  files: ["checksums.json", "index.js", "index.js.map", "plugin.json"],
  read() {
    return new Uint8Array();
  },
} satisfies PluginPayloadSnapshot;

const PREPARED: PreparedMainApplyTarget = {
  mainState: "cdp-main",
  host: {
    bundlePath: "/Applications/ChatGPT.app",
    executablePath: MAIN_TARGET.executablePath,
    bundleId: "com.openai.codex",
    executableName: "ChatGPT",
    signingTeam: "2DC432GLL2",
    appVersion: MAIN_TARGET.appVersion,
    appBuild: MAIN_TARGET.appBuild,
    hostHashes: {
      "Contents/Info.plist": "2".repeat(64),
      "Contents/MacOS/ChatGPT": "3".repeat(64),
      "Contents/Resources/app.asar": "4".repeat(64),
    },
  },
  target: MAIN_TARGET,
  compatibilityKeyHash: "5".repeat(64),
  sdkRuntimeIdentity: {
    version: "1.2.0",
    sha256: "a".repeat(64),
  },
};

const STAGED = createStagedMainArtifactReceipt({
  artifact: {
    ...SNAPSHOT.identity,
    lifecycle: SNAPSHOT.manifest.lifecycle,
    sdkRange: SNAPSHOT.manifest.sdkRange,
  },
  generation: GENERATION,
  sdkRuntimeIdentity: PREPARED.sdkRuntimeIdentity,
  devValidatedTarget: DEV_TARGET,
  devValidatedAt: "2026-07-28T01:10:00.000Z",
  compatibilityKeyHash: PREPARED.compatibilityKeyHash,
});
if (!STAGED.ok) throw new Error(STAGED.message);
const RECEIPT = STAGED.receipt;

function adapters(overrides: Partial<MainApplyAdapters> = {}): {
  value: MainApplyAdapters;
  calls: { authorize: number; apply: number; inspect: number; capture: number };
} {
  const calls = { authorize: 0, apply: 0, inspect: 0, capture: 0 };
  const value: MainApplyAdapters = {
    async loadReceipt() {
      return RECEIPT;
    },
    async captureArtifact() {
      calls.capture += 1;
      return {
        ok: true,
        validation: {
          ok: true,
          id: SNAPSHOT.identity.id,
          version: SNAPSHOT.identity.version,
          displayName: SNAPSHOT.manifest.displayName,
          description: SNAPSHOT.manifest.description,
          lifecycle: SNAPSHOT.manifest.lifecycle,
          sdkRange: SNAPSHOT.manifest.sdkRange,
          payloadSha256: SNAPSHOT.identity.payloadSha256,
          archiveSha256: null,
          archiveRootName: null,
          files: SNAPSHOT.files,
          registrationCount: 1,
          source: "directory",
        },
        snapshot: SNAPSHOT,
      };
    },
    async readGeneration() {
      return GENERATION;
    },
    async inspectMain() {
      calls.inspect += 1;
      return PREPARED;
    },
    async authorize() {
      calls.authorize += 1;
      return true;
    },
    async apply() {
      calls.apply += 1;
      return {
        ok: true,
        target: MAIN_TARGET,
        application: {
          schemaVersion: 1,
          ...SNAPSHOT.identity,
          status: "applied",
          boundary: "none",
          setupCount: 1,
          previousAppliedIdentity: null,
          appliedIdentity: SNAPSHOT.identity,
          stage: "setup",
          possiblePartialEffects: false,
        },
        baselineBefore: {
          pid: MAIN_TARGET.pid,
          processStartedAt: MAIN_TARGET.processStartedAt,
          targetId: MAIN_TARGET.targetId,
          executionContextUniqueId: MAIN_TARGET.executionContextUniqueId,
          url: MAIN_TARGET.targetUrl,
          timeOrigin: 100,
          historyLength: 4,
          route: "/thread/one",
          sdkRuntimeVersion: "1.2.0",
          sdkRuntimeSha256: "a".repeat(64),
          unrelatedPlugins: {
            other: {
              version: "other-1",
              payloadSha256: "6".repeat(64),
            },
          },
        },
        baselineAfter: {
          pid: MAIN_TARGET.pid,
          processStartedAt: MAIN_TARGET.processStartedAt,
          targetId: MAIN_TARGET.targetId,
          executionContextUniqueId: MAIN_TARGET.executionContextUniqueId,
          url: MAIN_TARGET.targetUrl,
          timeOrigin: 100,
          historyLength: 4,
          route: "/thread/one",
          sdkRuntimeVersion: "1.2.0",
          sdkRuntimeSha256: "a".repeat(64),
          unrelatedPlugins: {
            other: {
              version: "other-1",
              payloadSha256: "6".repeat(64),
            },
          },
        },
      };
    },
    nowMs: () => 10_000,
    ...overrides,
  };
  return { value, calls };
}

describe("M4-F08 conditional authoring-main apply", () => {
  test("JSON or non-TTY mode cannot manufacture an interactive checkpoint", async () => {
    expect(await authorizeMainApplyCheckpoint({
      json: true,
      checkpoint: {
        operationId: "json-main-attempt",
        expiresAt: "2026-07-28T00:01:00.000Z",
        target: MAIN_TARGET,
        host: PREPARED.host,
        compatibilityKeyHash: PREPARED.compatibilityKeyHash,
        sdkRuntimeIdentity: PREPARED.sdkRuntimeIdentity,
        artifact: SNAPSHOT.identity,
      },
      stdinIsTty: true,
      stdoutIsTty: true,
      writeStderr() {},
      async ask() {
        throw new Error("JSON mode must not prompt");
      },
    })).toBe(false);

    expect(await authorizeMainApplyCheckpoint({
      json: false,
      checkpoint: {
        operationId: "no-tty-main-attempt",
        expiresAt: "2026-07-28T00:01:00.000Z",
        target: MAIN_TARGET,
        host: PREPARED.host,
        compatibilityKeyHash: PREPARED.compatibilityKeyHash,
        sdkRuntimeIdentity: PREPARED.sdkRuntimeIdentity,
        artifact: SNAPSHOT.identity,
      },
      stdinIsTty: false,
      stdoutIsTty: true,
      writeStderr() {},
      async ask() {
        throw new Error("Non-TTY mode must not prompt");
      },
    })).toBe(false);

    let evidence = "";
    expect(await authorizeMainApplyCheckpoint({
      json: false,
      checkpoint: {
        operationId: "interactive-main-attempt",
        expiresAt: "2026-07-28T00:01:00.000Z",
        target: MAIN_TARGET,
        host: PREPARED.host,
        compatibilityKeyHash: PREPARED.compatibilityKeyHash,
        sdkRuntimeIdentity: PREPARED.sdkRuntimeIdentity,
        artifact: SNAPSHOT.identity,
      },
      stdinIsTty: true,
      stdoutIsTty: true,
      writeStderr(text) {
        evidence += text;
      },
      async ask() {
        return "interactive-main-attempt";
      },
    })).toBe(true);
    expect(evidence).toContain("interactive-main-attempt");
    expect(evidence).toContain(PREPARED.compatibilityKeyHash);
    expect(evidence).toContain(SNAPSHOT.identity.payloadSha256);
  });

  test("plain main blocks before checkpoint or evaluation and preserves the staged receipt", async () => {
    const fixture = adapters({
      async inspectMain() {
        return {
          mainState: "plain-main",
          recoveryGuidance:
            "Manually provide a debug-enabled main on 127.0.0.1:9333 and start a new operation.",
        };
      },
    });
    const result = await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "plain-main-attempt",
      timeoutMs: 5_000,
      adapters: fixture.value,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "main.hot-path-unavailable",
      stagedIdentity: SNAPSHOT.identity,
      sourceDelivered: false,
    });
    expect(fixture.calls.authorize).toBe(0);
    expect(fixture.calls.apply).toBe(0);
  });

  test("cdp-main observation alone returns authorization-required with zero apply", async () => {
    const fixture = adapters({
      async authorize() {
        fixture.calls.authorize += 1;
        return false;
      },
    });
    const result = await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "unauthorized-main-attempt",
      timeoutMs: 5_000,
      adapters: fixture.value,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "main.authorization-required",
      sourceDelivered: false,
      checkpoint: {
        operationId: "unauthorized-main-attempt",
        target: MAIN_TARGET,
      },
    });
    expect(fixture.calls.authorize).toBe(1);
    expect(fixture.calls.apply).toBe(0);
  });

  test("drift after checkpoint invalidates the operation without reconnect", async () => {
    const drifted = {
      ...PREPARED,
      target: {
        ...MAIN_TARGET,
        executionContextUniqueId: "replacement-context",
      },
    };
    let inspection = 0;
    const fixture = adapters({
      async inspectMain() {
        inspection += 1;
        return inspection === 1 ? PREPARED : drifted;
      },
    });
    const result = await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "drifted-main-attempt",
      timeoutMs: 5_000,
      adapters: fixture.value,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "main.authorization-mismatch",
      sourceDelivered: false,
    });
    expect(fixture.calls.apply).toBe(0);
    expect(inspection).toBe(2);
  });

  test("changed, local-SDK, and non-hot bytes block before apply", async () => {
    const changed = adapters({
      async captureArtifact() {
        changed.calls.capture += 1;
        return {
          ok: true,
          validation: {
            ok: true,
            id: SNAPSHOT.identity.id,
            version: SNAPSHOT.identity.version,
            displayName: SNAPSHOT.manifest.displayName,
            description: SNAPSHOT.manifest.description,
            lifecycle: SNAPSHOT.manifest.lifecycle,
            sdkRange: SNAPSHOT.manifest.sdkRange,
            payloadSha256: "8".repeat(64),
            archiveSha256: null,
            archiveRootName: null,
            files: SNAPSHOT.files,
            registrationCount: 1,
            source: "directory",
          },
          snapshot: {
            ...SNAPSHOT,
            identity: {
              ...SNAPSHOT.identity,
              payloadSha256: "8".repeat(64),
            },
          },
        };
      },
    });
    expect(await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "changed-main-attempt",
      timeoutMs: 5_000,
      adapters: changed.value,
    })).toMatchObject({
      ok: false,
      code: "main.staged-artifact-changed",
    });
    expect(changed.calls.apply).toBe(0);

    const localSdk = adapters({
      async readGeneration() {
        return {
          ...GENERATION,
          sdkInput: {
            kind: "local-source",
            version: "1.2.0-local",
            runtimeSha256: "a".repeat(64),
            declarationsSha256: "7".repeat(64),
          },
        };
      },
    });
    expect(await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "local-sdk-main-attempt",
      timeoutMs: 5_000,
      adapters: localSdk.value,
    })).toMatchObject({
      ok: false,
      code: "develop.local-sdk-not-publishable",
    });
    expect(localSdk.calls.apply).toBe(0);

    const nonHot = adapters({
      async captureArtifact() {
        nonHot.calls.capture += 1;
        return {
          ok: true,
          validation: {
            ok: true,
            id: SNAPSHOT.identity.id,
            version: SNAPSHOT.identity.version,
            displayName: SNAPSHOT.manifest.displayName,
            description: SNAPSHOT.manifest.description,
            lifecycle: "renderer-start",
            sdkRange: SNAPSHOT.manifest.sdkRange,
            payloadSha256: SNAPSHOT.identity.payloadSha256,
            archiveSha256: null,
            archiveRootName: null,
            files: SNAPSHOT.files,
            registrationCount: 1,
            source: "directory",
          },
          snapshot: {
            ...SNAPSHOT,
            manifest: {
              ...SNAPSHOT.manifest,
              lifecycle: "renderer-start",
            },
          },
        };
      },
    });
    expect(await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "non-hot-main-attempt",
      timeoutMs: 5_000,
      adapters: nonHot.value,
    })).toMatchObject({
      ok: false,
      code: "main.lifecycle-protected",
    });
    expect(nonHot.calls.apply).toBe(0);
  });

  test("fresh authorized apply runs once and returns the preserved exact baseline", async () => {
    const fixture = adapters();
    const result = await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "authorized-main-attempt",
      timeoutMs: 5_000,
      adapters: fixture.value,
    });
    expect(result).toMatchObject({
      ok: true,
      operationId: "authorized-main-attempt",
      appliedIdentity: SNAPSHOT.identity,
      target: MAIN_TARGET,
      baselinePreserved: true,
      sourceDelivered: true,
      authorizationConsumed: true,
      application: {
        status: "applied",
        setupCount: 1,
      },
    });
    expect(fixture.calls.authorize).toBe(1);
    expect(fixture.calls.capture).toBe(2);
    expect(fixture.calls.inspect).toBe(2);
    expect(fixture.calls.apply).toBe(1);
  });

  test("reports non-success if the authorized apply changes route or unrelated plugins", async () => {
    const fixture = adapters({
      async apply() {
        fixture.calls.apply += 1;
        const applied = await adapters().value.apply({
          operationId: "unused",
          prepared: PREPARED,
          snapshot: SNAPSHOT,
          authorization: {
            schemaVersion: 1,
            operationId: "unused",
            issuedAt: "2026-07-28T00:00:00.000Z",
            expiresAt: "2026-07-28T00:01:00.000Z",
            pid: MAIN_TARGET.pid,
            processStartedAt: MAIN_TARGET.processStartedAt,
            port: 9333,
            browserIdentity: MAIN_TARGET.browserIdentity,
            targetId: MAIN_TARGET.targetId,
            targetType: MAIN_TARGET.targetType,
            targetUrl: MAIN_TARGET.targetUrl,
            executionContextId: MAIN_TARGET.executionContextId,
            executionContextUniqueId:
              MAIN_TARGET.executionContextUniqueId,
            frameId: MAIN_TARGET.frameId,
            appVersion: MAIN_TARGET.appVersion,
            appBuild: MAIN_TARGET.appBuild,
            bundlePath: PREPARED.host.bundlePath,
            executablePath: PREPARED.host.executablePath,
            bundleId: PREPARED.host.bundleId,
            executableName: PREPARED.host.executableName,
            signingTeam: PREPARED.host.signingTeam,
            hostHashes: PREPARED.host.hostHashes,
            compatibilityKeyHash: PREPARED.compatibilityKeyHash,
            sdkRuntimeVersion: PREPARED.sdkRuntimeIdentity.version,
            sdkRuntimeSha256: PREPARED.sdkRuntimeIdentity.sha256,
            artifact: SNAPSHOT.identity,
          },
        });
        if (!applied.ok) return applied;
        return {
          ...applied,
          baselineAfter: {
            ...applied.baselineAfter,
            route: "/thread/changed",
            unrelatedPlugins: {
              other: null,
            },
          },
        };
      },
    });
    expect(await runMainApplyOperation({
      artifactPath: "/fixture/dist",
      operationId: "baseline-drift-main-attempt",
      timeoutMs: 5_000,
      adapters: fixture.value,
    })).toMatchObject({
      ok: false,
      code: "main.apply-incomplete",
      sourceDelivered: true,
    });
    expect(fixture.calls.apply).toBe(1);
  });
});
