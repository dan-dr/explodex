import { describe, expect, test } from "bun:test";
import {
  createPluginReviewController,
  formatReviewIdentityText,
  REVIEW_SECURITY_WARNING,
  type PluginReviewHost,
  type ReviewRenderModel,
} from "../../src/runtime/plugin-review.ts";

const DIGEST = "a".repeat(64);

function request() {
  return {
    schemaVersion: 1 as const,
    operationId: "review-operation",
    nonce: "review-nonce",
    callbackName: "__explodexReview_callback",
    expiresAtMs: 2_000,
    activationCommitment: "b".repeat(64),
    applicationTtlMs: 1_000,
    artifacts: [{
      id: "alpha",
      displayName: "Alpha",
      description: "Metadata-only fixture",
      version: "opaque-A",
      payloadSha256: DIGEST,
      sdkRange: "^0.2.0",
      sourceLabel: "Local archive: alpha.tgz",
    }],
  };
}

function harness() {
  let nowMs = 1_000;
  let rendered: ReviewRenderModel | null = null;
  let closeReason: string | null = null;
  const host: PluginReviewHost = {
    callbacks: {},
    now: () => nowMs,
    setTimeout(callback) {
      void callback;
      return 1;
    },
    clearTimeout() {},
  };
  const controller = createPluginReviewController({
    host,
    render(model) {
      rendered = model;
      return {
        close(reason) {
          closeReason = reason;
        },
      };
    },
  });
  return {
    host,
    controller,
    rendered: () => rendered,
    closeReason: () => closeReason,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

describe("M3-F04 renderer metadata-only plugin review", () => {
  test("renders the trusted-code warning and every visible control unselected", async () => {
    const fixture = harness();
    const pending = fixture.controller.open(request());
    const model = fixture.rendered();
    expect(model).not.toBeNull();
    expect(model?.warning).toBe(REVIEW_SECURITY_WARNING);
    expect(model?.warning).toContain("trusted unsandboxed");
    expect(model?.warning).toContain("authenticated renderer state");
    expect(model?.warning).toContain("not provide sandboxing");
    expect(model?.warning).toContain("publisher authentication");
    expect(model?.artifacts).toEqual([{
      ...request().artifacts[0],
      selected: false,
    }]);
    expect(Object.keys(model?.artifacts[0] ?? {}).sort()).toEqual([
      "description",
      "displayName",
      "id",
      "payloadSha256",
      "sdkRange",
      "selected",
      "sourceLabel",
      "version",
    ]);
    expect(formatReviewIdentityText(request().artifacts[0]!)).toBe(
      `alpha · opaque-A · ${DIGEST} · ^0.2.0 · Local archive: alpha.tgz`,
    );

    fixture.controller.cancel("cancelled");
    expect(await pending).toEqual({
      status: "cancelled",
      reason: "cancelled",
    });
    expect(fixture.closeReason()).toBe("cancelled");
  });

  test("passive interaction has no effect and submission sends exact selected tuples", async () => {
    const fixture = harness();
    const pending = fixture.controller.open(request());
    const model = fixture.rendered();
    expect(model).not.toBeNull();
    expect(model?.artifacts[0]?.selected).toBe(false);

    // Rendering, waiting, and focus/navigation signals do not call the callback.
    expect(typeof fixture.host.callbacks[request().callbackName]).toBe("function");
    model?.onFocus();
    model?.onNavigate();
    expect(typeof fixture.host.callbacks[request().callbackName]).toBe("function");

    model?.onToggle("alpha", "opaque-A", DIGEST, true);
    model?.onSubmit();
    expect(fixture.host.callbacks[request().callbackName]).toBeUndefined();
    expect(await pending).toEqual({
      status: "submitted",
      payload: {
        schemaVersion: 1,
        nonce: "review-nonce",
        selected: [{
          id: "alpha",
          version: "opaque-A",
          payloadSha256: DIGEST,
        }],
      },
    });
    expect(fixture.closeReason()).toBe("submitted");
  });

  test("empty submit is a no-op result while expiry, destroy, and duplicate open authorize nothing", async () => {
    const emptyFixture = harness();
    const emptyPending = emptyFixture.controller.open(request());
    emptyFixture.rendered()?.onSubmit();
    expect(await emptyPending).toEqual({
      status: "submitted",
      payload: {
        schemaVersion: 1,
        nonce: "review-nonce",
        selected: [],
      },
    });

    const expiredFixture = harness();
    expiredFixture.setNow(2_001);
    expect(await expiredFixture.controller.open(request())).toEqual({
      status: "expired",
      reason: "expired-before-render",
    });
    expect(expiredFixture.rendered()).toBeNull();

    const destroyFixture = harness();
    const destroyedPending = destroyFixture.controller.open(request());
    destroyFixture.controller.destroy();
    expect(await destroyedPending).toEqual({
      status: "cancelled",
      reason: "runtime-destroyed",
    });

    const duplicateFixture = harness();
    const first = duplicateFixture.controller.open(request());
    const second = duplicateFixture.controller.open(request());
    expect(await second).toEqual({
      status: "rejected",
      reason: "review-already-active",
    });
    duplicateFixture.controller.cancel("cancelled");
    await first;
  });

  test("terminal cleanup cancels only its exact operation and callback", async () => {
    const fixture = harness();
    const pending = fixture.controller.open(request());
    expect(fixture.controller.cancelExact(
      "other-operation",
      request().callbackName,
      "operation-terminal",
    )).toBe(false);
    expect(fixture.controller.cancelExact(
      request().operationId,
      "__explodexReview_other",
      "operation-terminal",
    )).toBe(false);
    expect(typeof fixture.host.callbacks[request().callbackName]).toBe("function");
    expect(fixture.controller.cancelExact(
      request().operationId,
      request().callbackName,
      "operation-terminal",
    )).toBe(true);
    expect(await pending).toEqual({
      status: "cancelled",
      reason: "operation-terminal",
    });
  });
});
