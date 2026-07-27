import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PRIVATE_REGISTER_GLOBAL } from "../../src/lifecycle/index.ts";
import {
  createPluginApplicationController,
  type PluginApplicationController,
} from "../../src/runtime/plugin-application.ts";
import type { PluginApi } from "../../src/types/plugin.ts";

const DIGEST = "a".repeat(64);
const ACTIVATION_SECRET = "b".repeat(64);
const ACTIVATION_COMMITMENT = createHash("sha256")
  .update(ACTIVATION_SECRET, "utf8")
  .digest("hex");

function input(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    operationId: "approval-operation",
    nonce: "approval-nonce",
    id: "alpha",
    version: "opaque-v1",
    payloadSha256: DIGEST,
    lifecycle: "dynamic",
    assets: [{
      path: "assets/notice.txt",
      bytes: [...new TextEncoder().encode("snapshot bytes")],
    }],
    ...overrides,
  };
}

function authorize(
  controller: PluginApplicationController,
  value = input(),
  applicationTtlMs = 60_000,
): void {
  controller.authorizeReview({
    schemaVersion: 1,
    operationId: String(value.operationId),
    nonce: String(value.nonce),
    callbackName: "__explodexReview_approval_operation",
    expiresAtMs: Date.now() + 60_000,
    activationCommitment: ACTIVATION_COMMITMENT,
    applicationTtlMs,
    artifacts: [{
      id: String(value.id),
      displayName: "Alpha",
      description: "",
      version: String(value.version),
      payloadSha256: String(value.payloadSha256),
      sdkRange: "^1.2.0",
      sourceLabel: "installed",
    }],
  }, {
    schemaVersion: 1,
    nonce: String(value.nonce),
    selected: [{
      id: String(value.id),
      version: String(value.version),
      payloadSha256: String(value.payloadSha256),
    }],
  });
}

describe("M3-F05 private approved-payload runtime application", () => {
  test("registers inertly, then runs setup once with scoped snapshot assets", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    authorize(controller);
    let setupCount = 0;
    let handleText = "";
    const result = await controller.applyApproved(input(), () => {
      const register = host[PRIVATE_REGISTER_GLOBAL];
      if (typeof register !== "function") throw new Error("missing register");
      register("alpha", {
        async setup(api: PluginApi) {
          setupCount += 1;
          const handle = await api.assets.open("notice.txt");
          handleText = await handle.text();
        },
      });
    }, ACTIVATION_SECRET);
    expect(result).toMatchObject({
      status: "applied",
      setupCount: 1,
      boundary: "none",
    });
    expect(setupCount).toBe(1);
    expect(handleText).toBe("snapshot bytes");
    await controller.destroy();
  });

  test("wrong or multiple registration never invokes setup", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    authorize(controller);
    let setupCount = 0;
    const wrong = await controller.applyApproved(input(), () => {
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("beta", {
        setup() {
          setupCount += 1;
        },
      });
    }, ACTIVATION_SECRET);
    expect(wrong.status).toBe("failed");

    authorize(controller);
    const multiple = await controller.applyApproved(input(), () => {
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("alpha", { setup() { setupCount += 1; } });
      register("alpha", { setup() { setupCount += 1; } });
    }, ACTIVATION_SECRET);
    expect(multiple.status).toBe("failed");
    expect(setupCount).toBe(0);
  });

  test("restart lifecycles remain source-absent and report their boundary", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    let evaluated = false;
    authorize(controller);
    const renderer = await controller.applyApproved(
      input({ lifecycle: "renderer-start" }),
      () => {
        evaluated = true;
      },
      ACTIVATION_SECRET,
    );
    authorize(controller);
    const app = await controller.applyApproved(
      input({ lifecycle: "app-start" }),
      () => {
        evaluated = true;
      },
      ACTIVATION_SECRET,
    );
    expect(renderer).toMatchObject({
      status: "boundary-required",
      boundary: "renderer",
      setupCount: 0,
    });
    expect(app).toMatchObject({
      status: "boundary-required",
      boundary: "app",
      setupCount: 0,
    });
    expect(evaluated).toBe(false);
  });

  test("rejects pre-commit, wrong-secret, replayed, and cross-operation application", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    let evaluated = 0;
    const apply = (
      value = input(),
      secret: unknown = ACTIVATION_SECRET,
    ) =>
      controller.applyApproved(value, () => {
        evaluated += 1;
      }, secret);

    expect((await apply()).error?.code).toBe(
      "plugin.application.unauthorized",
    );

    controller.authorizeReview({
      schemaVersion: 1,
      operationId: "approval-operation",
      nonce: "approval-nonce",
      callbackName: "__explodexReview_approval_operation",
      expiresAtMs: Date.now() + 60_000,
      activationCommitment: ACTIVATION_COMMITMENT,
      applicationTtlMs: 60_000,
      artifacts: [],
    }, {
      schemaVersion: 1,
      nonce: "approval-nonce",
      selected: [{
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      }],
    });
    expect((await apply(input(), null)).error?.code).toBe(
      "plugin.application.unauthorized",
    );
    expect((await apply(input(), "c".repeat(64))).error?.code).toBe(
      "plugin.application.unauthorized",
    );

    await apply();
    expect((await apply()).error?.code).toBe(
      "plugin.application.unauthorized",
    );

    authorize(controller);
    expect((await apply(input({ operationId: "other-operation" }))).error?.code)
      .toBe("plugin.application.unauthorized");
    expect(evaluated).toBe(1);

    authorize(controller);
    controller.finalizeApproved("approval-operation", "approval-nonce");
    expect((await apply()).error?.code).toBe(
      "plugin.application.unauthorized",
    );
  });
});
