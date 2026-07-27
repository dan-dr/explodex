import { describe, expect, test } from "bun:test";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  buildMetadataUpdateExpression,
  createUpdateReviewProtocolContext,
} from "../../src/plugin/update-review-protocol.ts";

const TARGET: TargetIdentity = {
  role: "development",
  pid: 4100,
  processStartedAt: "2026-07-27T16:00:00.000Z",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  appVersion: "current",
  appBuild: "current-build",
  port: 9444,
  browserIdentity: "Chrome/current",
  targetId: "UPDATE-PAGE",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 18,
  executionContextUniqueId: "update-context",
  frameId: "update-frame",
};

describe("M3-F07 exact update callback protocol", () => {
  test("uses a distinct update callback and embeds only metadata plus disposition IDs", () => {
    const context = createUpdateReviewProtocolContext({
      artifacts: [{
        id: "alpha",
        displayName: "Alpha",
        description: "Update metadata",
        version: "opaque-B",
        payloadSha256: "a".repeat(64),
        sdkRange: "^1.2.0",
        sourceLabel: "GitHub release: owner/repo",
      }],
      target: TARGET,
      operationId: "update-operation",
      nowMs: 1_000,
      ttlMs: 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    expect(context.callbackName).toStartWith("__explodexUpdate_");
    expect(context.callbackName).not.toStartWith("__explodexReview_");
    const expression = buildMetadataUpdateExpression({
      sdkRuntimeSource: "globalThis.Explodex = globalThis.Explodex;",
      context,
      enabledPluginIdentities: [{
        id: "alpha",
        version: "opaque-A",
        payloadSha256: "c".repeat(64),
      }],
      activationCommitment: "b".repeat(64),
      applicationTtlMs: 1_000,
    });
    expect(expression).toContain("runtime.updates.open");
    expect(expression).toContain("Update");
    expect(expression).toContain(context.callbackName);
    expect(expression).toContain("trusted unsandboxed");
    expect(expression).toContain(
      `"enabledPluginIdentities":[{"id":"alpha","version":"opaque-A","payloadSha256":"${"c".repeat(64)}"}]`,
    );
    expect(expression).toContain("__explodexAdoptRuntimeRequest");
    expect(expression).not.toContain("BUNDLE_SOURCE_SENTINEL");
    expect(Object.keys(context.artifacts[0]!).sort()).toEqual([
      "description",
      "displayName",
      "id",
      "payloadSha256",
      "sdkRange",
      "sourceLabel",
      "version",
    ]);
  });
});
