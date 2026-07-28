import { describe, expect, test } from "bun:test";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import type { HostIdentity } from "../../src/host/types.ts";
import {
  createMainAuthorization,
  type MainAuthorizationBinding,
} from "../../src/host/main-authorization.ts";

const HOST: HostIdentity = {
  bundlePath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleId: "com.openai.codex",
  executableName: "ChatGPT",
  signingTeam: "2DC432GLL2",
  appVersion: "26.800.1",
  appBuild: "6001",
  hostHashes: {
    "Contents/Info.plist": "1".repeat(64),
    "Contents/MacOS/ChatGPT": "2".repeat(64),
    "Contents/Resources/app.asar": "3".repeat(64),
  },
};

const TARGET: TargetIdentity = {
  role: "main",
  pid: 410,
  processStartedAt: "2026-07-28T01:02:03.000000Z",
  executablePath: HOST.executablePath,
  appVersion: HOST.appVersion,
  appBuild: HOST.appBuild,
  port: 9333,
  browserIdentity: "Chrome/140",
  targetId: "main-target",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 17,
  executionContextUniqueId: "main-context",
  frameId: "main-frame",
};

function binding(): MainAuthorizationBinding {
  return {
    operationId: "main-apply-operation",
    target: TARGET,
    host: HOST,
    compatibilityKeyHash: "4".repeat(64),
    sdkRuntimeIdentity: {
      version: "1.2.0",
      sha256: "9".repeat(64),
    },
    artifact: {
      id: "safe-main",
      version: "opaque-1",
      payloadSha256: "5".repeat(64),
    },
  };
}

describe("M4-F08 exact authoring-main authorization", () => {
  test("binds the full operation, host, target, compatibility, and artifact identity", () => {
    const lease = createMainAuthorization({
      binding: binding(),
      issuedAtMs: 1_000,
      ttlMs: 5_000,
    });
    expect(lease.record).toMatchObject({
      schemaVersion: 1,
      operationId: "main-apply-operation",
      expiresAt: "1970-01-01T00:00:06.000Z",
      pid: 410,
      processStartedAt: TARGET.processStartedAt,
      port: 9333,
      targetId: "main-target",
      targetType: "page",
      targetUrl: "app://-/index.html",
      executionContextId: 17,
      executionContextUniqueId: "main-context",
      appVersion: HOST.appVersion,
      appBuild: HOST.appBuild,
      bundlePath: HOST.bundlePath,
      executablePath: HOST.executablePath,
      bundleId: HOST.bundleId,
      signingTeam: HOST.signingTeam,
      hostHashes: HOST.hostHashes,
      compatibilityKeyHash: "4".repeat(64),
      sdkRuntimeVersion: "1.2.0",
      sdkRuntimeSha256: "9".repeat(64),
      artifact: binding().artifact,
    });
    expect(lease.validateAndConsume({
      binding: binding(),
      nowMs: 5_999,
    })).toEqual({ ok: true });
  });

  test("expires, rejects every exact-identity drift, and cannot be replayed", () => {
    const base = binding();
    const mismatches: MainAuthorizationBinding[] = [
      { ...base, operationId: "other-operation" },
      { ...base, compatibilityKeyHash: "6".repeat(64) },
      {
        ...base,
        sdkRuntimeIdentity: {
          ...base.sdkRuntimeIdentity,
          sha256: "8".repeat(64),
        },
      },
      { ...base, target: { ...base.target, pid: 411 } },
      {
        ...base,
        target: {
          ...base.target,
          processStartedAt: "2026-07-28T01:02:04.000000Z",
        },
      },
      { ...base, target: { ...base.target, targetId: "replacement-target" } },
      {
        ...base,
        target: {
          ...base.target,
          executionContextUniqueId: "replacement-context",
        },
      },
      { ...base, host: { ...base.host, appBuild: "6002" } },
      {
        ...base,
        host: {
          ...base.host,
          hostHashes: {
            ...base.host.hostHashes,
            "Contents/Resources/app.asar": "7".repeat(64),
          },
        },
      },
      {
        ...base,
        artifact: { ...base.artifact, payloadSha256: "8".repeat(64) },
      },
    ];
    for (const mismatch of mismatches) {
      const lease = createMainAuthorization({
        binding: base,
        issuedAtMs: 10_000,
        ttlMs: 5_000,
      });
      expect(lease.validateAndConsume({
        binding: mismatch,
        nowMs: 11_000,
      })).toMatchObject({
        ok: false,
        code: "main.authorization-mismatch",
      });
      expect(lease.consumed).toBe(false);
    }

    const expired = createMainAuthorization({
      binding: base,
      issuedAtMs: 10_000,
      ttlMs: 5_000,
    });
    expect(expired.validateAndConsume({
      binding: base,
      nowMs: 15_000,
    })).toMatchObject({
      ok: false,
      code: "main.authorization-expired",
    });

    const replay = createMainAuthorization({
      binding: base,
      issuedAtMs: 10_000,
      ttlMs: 5_000,
    });
    expect(replay.validateAndConsume({
      binding: base,
      nowMs: 11_000,
    })).toEqual({ ok: true });
    expect(replay.validateAndConsume({
      binding: base,
      nowMs: 11_001,
    })).toMatchObject({
      ok: false,
      code: "main.authorization-replayed",
    });
  });
});
