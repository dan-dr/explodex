import { describe, expect, test } from "bun:test";
import {
  createPluginReviewController,
  REVIEW_SECURITY_WARNING,
  type PluginReviewHost,
  type ReviewRenderModel,
} from "../../src/runtime/plugin-review.ts";

const DIGEST = "a".repeat(64);

function pendingRequest() {
  return {
    schemaVersion: 1 as const,
    operationId: "pending-operation",
    nonce: "pending-nonce",
    callbackName: "__explodexReview_pending",
    expiresAtMs: 2_000,
    activationCommitment: "b".repeat(64),
    applicationTtlMs: 1_000,
    artifacts: [{
      id: "new-plugin",
      displayName: "New plugin",
      description: "Pending metadata",
      version: "pending-v1",
      payloadSha256: DIGEST,
      sdkRange: "^1.2.0",
      sourceLabel: "Local archive: pending.tgz",
    }],
  };
}

function updateRequest() {
  return {
    schemaVersion: 1 as const,
    surface: "update" as const,
    operationId: "update-operation",
    nonce: "update-nonce",
    callbackName: "__explodexUpdate_selected",
    expiresAtMs: 2_000,
    activationCommitment: "c".repeat(64),
    applicationTtlMs: 1_000,
    enabledPluginIds: ["enabled-plugin"],
    artifacts: [{
      id: "enabled-plugin",
      displayName: "Enabled plugin",
      description: "Exact enabled replacement",
      version: "opaque-B",
      payloadSha256: "d".repeat(64),
      sdkRange: "^1.2.0",
      sourceLabel: "GitHub release: owner/repo",
    }, {
      id: "disabled-plugin",
      displayName: "Disabled plugin",
      description: "Exact disabled recommendation",
      version: "opaque-C",
      payloadSha256: "e".repeat(64),
      sdkRange: "^1.2.0",
      sourceLabel: "Registry: owner/repo",
    }],
  };
}

function harness() {
  let nowMs = 1_000;
  const rendered: ReviewRenderModel[] = [];
  const host: PluginReviewHost = {
    callbacks: {},
    now: () => nowMs,
    setTimeout() {
      return {};
    },
    clearTimeout() {},
  };
  const pending = createPluginReviewController({
    host,
    surface: "pending",
    render(model) {
      rendered.push(model);
      return { close() {} };
    },
  });
  const updates = createPluginReviewController({
    host,
    surface: "update",
    render(model) {
      rendered.push(model);
      return { close() {} };
    },
  });
  return {
    host,
    pending,
    updates,
    rendered,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

describe("M3-F07 independent metadata-only update review", () => {
  test("pending and update surfaces keep separate callbacks and cancellation state", async () => {
    const fixture = harness();
    const pendingOutcome = fixture.pending.open(pendingRequest());
    const updateOutcome = fixture.updates.open(updateRequest());

    expect(Object.keys(fixture.host.callbacks).sort()).toEqual([
      "__explodexReview_pending",
      "__explodexUpdate_selected",
    ]);
    expect(fixture.rendered).toHaveLength(2);
    expect(fixture.rendered[0]?.surface).toBe("pending");
    expect(fixture.rendered[1]?.surface).toBe("update");
    expect(fixture.rendered[1]?.warning).toBe(REVIEW_SECURITY_WARNING);
    expect(fixture.rendered[1]?.submitLabel).toBe("Update Selected");
    expect(fixture.rendered[1]?.artifacts.map((artifact) => ({
      id: artifact.id,
      selected: artifact.selected,
      disposition: artifact.disposition,
    }))).toEqual([
      {
        id: "enabled-plugin",
        selected: false,
        disposition: "will-replace-enabled",
      },
      {
        id: "disabled-plugin",
        selected: false,
        disposition: "will-remain-disabled",
      },
    ]);
    expect(Object.keys(updateRequest().artifacts[0]!).sort()).toEqual([
      "description",
      "displayName",
      "id",
      "payloadSha256",
      "sdkRange",
      "sourceLabel",
      "version",
    ]);

    fixture.pending.cancel("pending-cancelled");
    expect(await pendingOutcome).toEqual({
      status: "cancelled",
      reason: "pending-cancelled",
    });
    expect(fixture.host.callbacks.__explodexReview_pending).toBeUndefined();
    expect(typeof fixture.host.callbacks.__explodexUpdate_selected).toBe(
      "function",
    );

    fixture.rendered[1]?.onToggle(
      "enabled-plugin",
      "opaque-B",
      "d".repeat(64),
      true,
    );
    fixture.rendered[1]?.onSubmit();
    expect(await updateOutcome).toEqual({
      status: "submitted",
      payload: {
        schemaVersion: 1,
        nonce: "update-nonce",
        selected: [{
          id: "enabled-plugin",
          version: "opaque-B",
          payloadSha256: "d".repeat(64),
        }],
      },
    });
    expect(fixture.host.callbacks.__explodexUpdate_selected).toBeUndefined();
  });

  test("empty selection is a no-op and an expired update does not consume pending review", async () => {
    const fixture = harness();
    const pendingOutcome = fixture.pending.open(pendingRequest());
    const emptyUpdate = fixture.updates.open(updateRequest());
    fixture.rendered[1]?.onSubmit();
    expect(await emptyUpdate).toEqual({
      status: "submitted",
      payload: {
        schemaVersion: 1,
        nonce: "update-nonce",
        selected: [],
      },
    });
    expect(typeof fixture.host.callbacks.__explodexReview_pending).toBe(
      "function",
    );

    fixture.setNow(2_001);
    expect(await fixture.updates.open(updateRequest())).toEqual({
      status: "expired",
      reason: "expired-before-render",
    });
    expect(typeof fixture.host.callbacks.__explodexReview_pending).toBe(
      "function",
    );
    fixture.pending.cancel("done");
    await pendingOutcome;
  });
});
