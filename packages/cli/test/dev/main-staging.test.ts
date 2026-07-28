import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  createStagedMainArtifactReceipt,
  loadStagedMainArtifactReceipt,
  saveStagedMainArtifactReceipt,
  validateStagedMainArtifact,
} from "../../src/dev/main-staging.ts";
import type { GenerationRecord } from "../../src/plugin/generation.ts";

const DEV_TARGET: TargetIdentity = {
  role: "development",
  pid: 501,
  processStartedAt: "2026-07-28T01:00:00.000000Z",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  appVersion: "26.800.1",
  appBuild: "6001",
  port: 9444,
  browserIdentity: "Chrome/140",
  targetId: "dev-target",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 12,
  executionContextUniqueId: "dev-context",
  frameId: "dev-frame",
};

const GENERATION: GenerationRecord = {
  schemaVersion: 1,
  generationId: "generation-1",
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

const ARTIFACT = {
  id: "safe-main",
  version: "opaque-1",
  payloadSha256: "1".repeat(64),
  lifecycle: "dynamic" as const,
  sdkRange: "^1.2.0",
};

describe("M4-F08 staged main artifact receipts", () => {
  test("records one exact publishable dev validation identity", () => {
    const result = createStagedMainArtifactReceipt({
      artifact: ARTIFACT,
      generation: GENERATION,
      sdkRuntimeIdentity: {
        version: "1.2.0",
        sha256: "a".repeat(64),
      },
      devValidatedTarget: DEV_TARGET,
      devValidatedAt: "2026-07-28T01:01:00.000Z",
      compatibilityKeyHash: "2".repeat(64),
    });
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        schemaVersion: 1,
        id: ARTIFACT.id,
        version: ARTIFACT.version,
        payloadSha256: ARTIFACT.payloadSha256,
        lifecycle: "dynamic",
        sdkRange: ARTIFACT.sdkRange,
        builtWithPublishableSdk: true,
        generationId: "generation-1",
        sdkRuntimeVersion: "1.2.0",
        sdkRuntimeSha256: "a".repeat(64),
        devValidatedTarget: DEV_TARGET,
        compatibilityKeyHash: "2".repeat(64),
      },
    });
  });

  test("rejects local SDK, non-hot lifecycle, and mismatched dev receipts", () => {
    expect(createStagedMainArtifactReceipt({
      artifact: ARTIFACT,
      generation: {
        ...GENERATION,
        sdkInput: {
          kind: "local-source",
          version: "1.2.0-local",
          runtimeSha256: "a".repeat(64),
          declarationsSha256: "9".repeat(64),
        },
      },
      sdkRuntimeIdentity: {
        version: "1.2.0-local",
        sha256: "a".repeat(64),
      },
      devValidatedTarget: DEV_TARGET,
      devValidatedAt: "2026-07-28T01:01:00.000Z",
      compatibilityKeyHash: "2".repeat(64),
    })).toMatchObject({
      ok: false,
      code: "develop.local-sdk-not-publishable",
    });
    expect(createStagedMainArtifactReceipt({
      artifact: { ...ARTIFACT, lifecycle: "renderer-start" },
      generation: GENERATION,
      sdkRuntimeIdentity: {
        version: "1.2.0",
        sha256: "a".repeat(64),
      },
      devValidatedTarget: DEV_TARGET,
      devValidatedAt: "2026-07-28T01:01:00.000Z",
      compatibilityKeyHash: "2".repeat(64),
    })).toMatchObject({
      ok: false,
      code: "main.lifecycle-protected",
    });
    expect(createStagedMainArtifactReceipt({
      artifact: { ...ARTIFACT, payloadSha256: "3".repeat(64) },
      generation: GENERATION,
      sdkRuntimeIdentity: {
        version: "1.2.0",
        sha256: "a".repeat(64),
      },
      devValidatedTarget: DEV_TARGET,
      devValidatedAt: "2026-07-28T01:01:00.000Z",
      compatibilityKeyHash: "2".repeat(64),
    })).toMatchObject({
      ok: false,
      code: "develop.dev-revalidation-required",
    });
  });

  test("final preflight accepts only unchanged dynamic publishable SDK-compatible bytes", () => {
    const staged = createStagedMainArtifactReceipt({
      artifact: ARTIFACT,
      generation: GENERATION,
      sdkRuntimeIdentity: {
        version: "1.2.0",
        sha256: "a".repeat(64),
      },
      devValidatedTarget: DEV_TARGET,
      devValidatedAt: "2026-07-28T01:01:00.000Z",
      compatibilityKeyHash: "2".repeat(64),
    });
    if (!staged.ok) throw new Error(staged.message);
    expect(validateStagedMainArtifact({
      receipt: staged.receipt,
      artifact: ARTIFACT,
      generation: GENERATION,
      mainSdkRuntime: {
        version: "1.2.0",
        sha256: "a".repeat(64),
      },
      compatibilityKeyHash: "2".repeat(64),
    })).toEqual({ ok: true });

    const rows = [
      {
        artifact: { ...ARTIFACT, payloadSha256: "4".repeat(64) },
        generation: GENERATION,
        mainSdkRuntime: {
          version: "1.2.0",
          sha256: "a".repeat(64),
        },
        compatibilityKeyHash: "2".repeat(64),
        code: "main.staged-artifact-changed",
      },
      {
        artifact: { ...ARTIFACT, lifecycle: "app-start" as const },
        generation: GENERATION,
        mainSdkRuntime: {
          version: "1.2.0",
          sha256: "a".repeat(64),
        },
        compatibilityKeyHash: "2".repeat(64),
        code: "main.lifecycle-protected",
      },
      {
        artifact: ARTIFACT,
        generation: {
          ...GENERATION,
          sdkInput: {
            kind: "local-source" as const,
            version: "1.2.0-local",
            runtimeSha256: "a".repeat(64),
            declarationsSha256: "9".repeat(64),
          },
        },
        mainSdkRuntime: {
          version: "1.2.0",
          sha256: "a".repeat(64),
        },
        compatibilityKeyHash: "2".repeat(64),
        code: "develop.local-sdk-not-publishable",
      },
      {
        artifact: ARTIFACT,
        generation: GENERATION,
        mainSdkRuntime: {
          version: "1.2.1",
          sha256: "8".repeat(64),
        },
        compatibilityKeyHash: "2".repeat(64),
        code: "main.sdk-runtime-changed",
      },
      {
        artifact: ARTIFACT,
        generation: GENERATION,
        mainSdkRuntime: {
          version: "1.2.0",
          sha256: "a".repeat(64),
        },
        compatibilityKeyHash: "7".repeat(64),
        code: "compatibility.drifted",
      },
    ];
    for (const row of rows) {
      expect(validateStagedMainArtifact({
        receipt: staged.receipt,
        artifact: row.artifact,
        generation: row.generation,
        mainSdkRuntime: row.mainSdkRuntime,
        compatibilityKeyHash: row.compatibilityKeyHash,
      })).toMatchObject({ ok: false, code: row.code });
    }
  });

  test("persists one private exact receipt and fails closed on malformed replacement", async () => {
    const staged = createStagedMainArtifactReceipt({
      artifact: ARTIFACT,
      generation: GENERATION,
      sdkRuntimeIdentity: {
        version: "1.2.0",
        sha256: "a".repeat(64),
      },
      devValidatedTarget: DEV_TARGET,
      devValidatedAt: "2026-07-28T01:01:00.000Z",
      compatibilityKeyHash: "2".repeat(64),
    });
    if (!staged.ok) throw new Error(staged.message);
    const home = await mkdtemp(join(tmpdir(), "explodex-main-staging-"));
    try {
      const path = await saveStagedMainArtifactReceipt({
        explodexHome: home,
        receipt: staged.receipt,
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await loadStagedMainArtifactReceipt({
        explodexHome: home,
        id: staged.receipt.id,
        payloadSha256: staged.receipt.payloadSha256,
      })).toEqual(staged.receipt);

      await writeFile(path, `${JSON.stringify({
        ...JSON.parse(await readFile(path, "utf8")),
        builtWithPublishableSdk: false,
      })}\n`);
      expect(await loadStagedMainArtifactReceipt({
        explodexHome: home,
        id: staged.receipt.id,
        payloadSha256: staged.receipt.payloadSha256,
      })).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
