import { describe, expect, test } from "bun:test";
import {
  buildMetadataReviewExpression,
  createReviewProtocolContext,
  createReviewSelectionAcceptor,
  selectPendingReviewArtifacts,
  type ReviewArtifact,
} from "../../src/plugin/review-protocol.ts";
import type { TargetIdentity } from "../../src/cdp/types.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const TARGET: TargetIdentity = {
  role: "development",
  pid: 4123,
  processStartedAt: "2026-07-27T05:00:00.000Z",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  appVersion: "26.721.41059",
  appBuild: "5848",
  port: 9444,
  browserIdentity: "Chrome/136",
  targetId: "target-review",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 17,
  executionContextUniqueId: "context-review",
  frameId: "frame-review",
};

const ARTIFACTS: ReviewArtifact[] = [
  {
    id: "alpha",
    displayName: "Alpha",
    description: "First fixture",
    version: "build-A",
    payloadSha256: DIGEST_A,
    sdkRange: "^0.2.0",
    sourceLabel: "Local archive: alpha.tgz",
  },
  {
    id: "beta",
    displayName: "Beta",
    description: "Second fixture",
    version: "build-B",
    payloadSha256: DIGEST_B,
    sdkRange: "^0.2.0",
    sourceLabel: "Local archive: beta.tgz",
  },
];

function context() {
  return createReviewProtocolContext({
    artifacts: ARTIFACTS,
    target: TARGET,
    nowMs: 10_000,
    ttlMs: 5_000,
    randomBytes: (length) => Uint8Array.from(
      { length },
      (_, index) => index + 1,
    ),
  });
}

describe("M3-F04 exact metadata review protocol", () => {
  test("creates fresh bounded context and embeds only seven-field metadata", () => {
    const first = context();
    const second = createReviewProtocolContext({
      artifacts: ARTIFACTS,
      target: TARGET,
      nowMs: 10_001,
      ttlMs: 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });

    expect(first.operationId).not.toBe(second.operationId);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.callbackName).not.toBe(second.callbackName);
    expect(first.expiresAtMs).toBe(15_000);
    expect(first.target).toEqual(TARGET);
    expect(first.artifacts.every((artifact) =>
      Object.keys(artifact).sort().join(",") ===
        "description,displayName,id,payloadSha256,sdkRange,sourceLabel,version"
    )).toBe(true);

    const expression = buildMetadataReviewExpression({
      sdkRuntimeSource: "globalThis.Explodex = globalThis.Explodex;",
      context: first,
      activationCommitment: "b".repeat(64),
      applicationTtlMs: 1_000,
    });
    expect(expression).toContain("trusted unsandboxed");
    expect(expression).toContain(first.callbackName);
    expect(expression).toContain(first.nonce);
    expect(expression).not.toContain("BUNDLE_SOURCE_SENTINEL");
    expect(expression).not.toContain("MAP_SOURCE_SENTINEL");
    expect(expression).not.toContain("/private/user/plugin/source");
    expect(expression).not.toContain("archiveSha256");
    expect(expression).not.toContain("relativePath");
    expect(expression).not.toContain('"source":');
  });

  test("accepts one exact in-context selection once, including an empty no-op", () => {
    const protocol = context();
    const acceptor = createReviewSelectionAcceptor(protocol);
    const accepted = acceptor.accept({
      schemaVersion: 1,
      nonce: protocol.nonce,
      selected: [{
        id: "alpha",
        version: "build-A",
        payloadSha256: DIGEST_A,
      }],
    }, {
      nowMs: 12_000,
      target: TARGET,
    });
    expect(accepted).toEqual({
      ok: true,
      selected: [{
        id: "alpha",
        version: "build-A",
        payloadSha256: DIGEST_A,
      }],
    });
    expect(acceptor.accept({
      schemaVersion: 1,
      nonce: protocol.nonce,
      selected: [],
    }, {
      nowMs: 12_001,
      target: TARGET,
    })).toMatchObject({
      ok: false,
      code: "plugin.review.replayed",
    });

    const empty = createReviewSelectionAcceptor(context()).accept({
      schemaVersion: 1,
      nonce: context().nonce,
      selected: [],
    }, {
      nowMs: 12_000,
      target: TARGET,
    });
    expect(empty).toEqual({ ok: true, selected: [] });
  });

  test("all review-only enable entry points require one exact pending identity when narrowed", () => {
    expect(selectPendingReviewArtifacts({
      pending: ARTIFACTS,
      request: {},
    })).toEqual({ ok: true, artifacts: ARTIFACTS });
    expect(selectPendingReviewArtifacts({
      pending: ARTIFACTS,
      request: { id: "alpha" },
    })).toEqual({ ok: true, artifacts: [ARTIFACTS[0]] });
    expect(selectPendingReviewArtifacts({
      pending: [
        ARTIFACTS[0]!,
        {
          ...ARTIFACTS[0]!,
          version: "build-A2",
          payloadSha256: DIGEST_B,
        },
      ],
      request: { id: "alpha" },
    })).toMatchObject({
      ok: false,
      code: "plugin.review.exact-selection-required",
    });
    expect(selectPendingReviewArtifacts({
      pending: ARTIFACTS,
      request: {
        id: "alpha",
        version: "build-A",
        payloadSha256: DIGEST_A,
      },
    })).toEqual({ ok: true, artifacts: [ARTIFACTS[0]] });
    expect(selectPendingReviewArtifacts({
      pending: ARTIFACTS,
      request: {
        id: "alpha",
        version: "build-A",
        payloadSha256: DIGEST_B,
      },
    })).toMatchObject({
      ok: false,
      code: "plugin.review.identity-not-pending",
    });
  });

  test("rejects the whole malformed, stale, duplicate, extra, and cross-context matrix", () => {
    const cases: Array<{
      name: string;
      payload: unknown;
      target?: TargetIdentity;
      nowMs?: number;
      code: string;
    }> = [
      {
        name: "wrong schema",
        payload: { schemaVersion: 2, nonce: context().nonce, selected: [] },
        code: "plugin.review.invalid-response",
      },
      {
        name: "wrong nonce",
        payload: { schemaVersion: 1, nonce: "other", selected: [] },
        code: "plugin.review.nonce-mismatch",
      },
      {
        name: "duplicate tuple",
        payload: {
          schemaVersion: 1,
          nonce: context().nonce,
          selected: [
            { id: "alpha", version: "build-A", payloadSha256: DIGEST_A },
            { id: "alpha", version: "build-A", payloadSha256: DIGEST_A },
          ],
        },
        code: "plugin.review.duplicate-selection",
      },
      {
        name: "two identities for one id",
        payload: {
          schemaVersion: 1,
          nonce: context().nonce,
          selected: [
            { id: "alpha", version: "build-A", payloadSha256: DIGEST_A },
            { id: "alpha", version: "build-B", payloadSha256: DIGEST_B },
          ],
        },
        code: "plugin.review.multiple-identities",
      },
      {
        name: "unreviewed tuple",
        payload: {
          schemaVersion: 1,
          nonce: context().nonce,
          selected: [
            { id: "gamma", version: "build-C", payloadSha256: "c".repeat(64) },
          ],
        },
        code: "plugin.review.unreviewed-selection",
      },
      {
        name: "normalized checksum substitution",
        payload: {
          schemaVersion: 1,
          nonce: context().nonce,
          selected: [
            { id: "alpha", version: "build-A", payloadSha256: DIGEST_A.toUpperCase() },
          ],
        },
        code: "plugin.review.unreviewed-selection",
      },
      {
        name: "expired",
        payload: { schemaVersion: 1, nonce: context().nonce, selected: [] },
        nowMs: 15_001,
        code: "plugin.review.expired",
      },
      {
        name: "context replacement",
        payload: { schemaVersion: 1, nonce: context().nonce, selected: [] },
        target: { ...TARGET, executionContextUniqueId: "replacement" },
        code: "plugin.review.context-mismatch",
      },
      {
        name: "target replacement",
        payload: { schemaVersion: 1, nonce: context().nonce, selected: [] },
        target: { ...TARGET, targetId: "replacement" },
        code: "plugin.review.context-mismatch",
      },
    ];

    for (const fixture of cases) {
      const protocol = context();
      const payload = JSON.parse(
        JSON.stringify(fixture.payload).replaceAll(
          context().nonce,
          protocol.nonce,
        ),
      ) as unknown;
      const result = createReviewSelectionAcceptor(protocol).accept(payload, {
        nowMs: fixture.nowMs ?? 12_000,
        target: fixture.target ?? TARGET,
      });
      expect(result, fixture.name).toMatchObject({
        ok: false,
        code: fixture.code,
      });
    }
  });
});
