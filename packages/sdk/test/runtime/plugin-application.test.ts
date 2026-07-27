import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PRIVATE_REGISTER_GLOBAL } from "../../src/lifecycle/index.ts";
import {
  createPluginApplicationController,
  type PluginApplicationController,
  type PluginRuntimeDiagnostic,
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

  test("repeated exact application converges without duplicate setup", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    let setupCount = 0;
    const apply = async () => {
      authorize(controller);
      return controller.applyApproved(input(), () => {
        const register = host[PRIVATE_REGISTER_GLOBAL] as (
          id: string,
          definition: unknown,
        ) => void;
        register("alpha", {
          setup() {
            setupCount += 1;
          },
        });
      }, ACTIVATION_SECRET);
    };

    const first = await apply();
    const second = await apply();

    expect(first).toMatchObject({
      status: "applied",
      previousAppliedIdentity: null,
      appliedIdentity: {
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      },
    });
    expect(second).toMatchObject({
      status: "unchanged",
      previousAppliedIdentity: {
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      },
      appliedIdentity: {
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      },
      setupCount: 0,
    });
    expect(setupCount).toBe(1);
    await controller.destroy();
  });

  test("enabled reconciliation capability can be claimed and consumed only once", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    const capability = controller.claimEnabledReconciliation();
    expect(capability).not.toBeNull();
    expect(controller.claimEnabledReconciliation()).toBeNull();
    if (capability === null) throw new Error("missing reconciliation capability");
    let evaluated = 0;
    const first = await capability(input(), () => {
      evaluated += 1;
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("alpha", { setup() {} });
    });
    const replay = await capability(input(), () => {
      evaluated += 1;
    });

    expect(first.status).toBe("applied");
    expect(replay).toMatchObject({
      status: "failed",
      error: { code: "plugin.application.unauthorized" },
    });
    expect(evaluated).toBe(1);
    await controller.destroy();
  });

  test("failed replacement preserves the prior live identity and reports possible partial effects", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    let oldTeardownCount = 0;
    authorize(controller);
    const first = await controller.applyApproved(input(), () => {
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("alpha", {
        setup() {
          return () => {
            oldTeardownCount += 1;
          };
        },
      });
    }, ACTIVATION_SECRET);
    expect(first.status).toBe("applied");

    const replacement = input({
      version: "opaque-v2",
      payloadSha256: "c".repeat(64),
    });
    authorize(controller, replacement);
    const failed = await controller.applyApproved(replacement, () => {
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("alpha", {
        setup() {
          (host as Record<string, unknown>).__partialEffect = true;
          throw new Error("replacement setup failed");
        },
      });
    }, ACTIVATION_SECRET);

    expect(failed).toMatchObject({
      status: "failed",
      stage: "setup",
      possiblePartialEffects: true,
      previousAppliedIdentity: {
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      },
      appliedIdentity: {
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      },
    });
    expect(oldTeardownCount).toBe(0);
    expect(controller.status("alpha")?.identity).toEqual({
      id: "alpha",
      version: "opaque-v1",
      payloadSha256: DIGEST,
    });
    await controller.destroy();
    expect(oldTeardownCount).toBe(1);
  });

  test("later runtime errors are observable without changing the live identity", async () => {
    const host: Record<string, unknown> = {};
    const diagnostics: Array<{
      code: string;
      message: string;
      identity: { id: string; version: string; payloadSha256: string };
    }> = [];
    const controller = createPluginApplicationController({
      host,
      onDiagnostic(diagnostic) {
        diagnostics.push({
          code: diagnostic.code,
          message: diagnostic.message,
          identity: diagnostic.identity,
        });
      },
    });
    authorize(controller);
    const applied = await controller.applyApproved(input(), () => {
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("alpha", {
        setup(api: PluginApi) {
          api.track.timeout(() => {
            throw new Error("delayed callback failed");
          }, 0);
        },
      });
    }, ACTIVATION_SECRET);
    expect(applied.status).toBe("applied");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(diagnostics).toEqual([{
      code: "plugin.runtime.error",
      message: "delayed callback failed",
      identity: {
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      },
    }]);
    expect(controller.status("alpha")?.identity).toEqual({
      id: "alpha",
      version: "opaque-v1",
      payloadSha256: DIGEST,
    });
    await controller.destroy();
  });

  test("delayed errors stay attributed to their originating generation", async () => {
    const host: Record<string, unknown> = {};
    const diagnostics: PluginRuntimeDiagnostic[] = [];
    const controller = createPluginApplicationController({
      host,
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });
    authorize(controller);
    await controller.applyApproved(input(), () => {
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("alpha", {
        setup(api: PluginApi) {
          api.track.timeout(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("old generation failed");
          }, 0);
        },
      });
    }, ACTIVATION_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replacement = input({
      version: "opaque-v2",
      payloadSha256: "d".repeat(64),
    });
    authorize(controller, replacement);
    await controller.applyApproved(replacement, () => {
      const register = host[PRIVATE_REGISTER_GLOBAL] as (
        id: string,
        definition: unknown,
      ) => void;
      register("alpha", { setup() {} });
    }, ACTIVATION_SECRET);

    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(diagnostics).toEqual([{
      id: "alpha",
      code: "plugin.runtime.error",
      message: "old generation failed",
      identity: {
        id: "alpha",
        version: "opaque-v1",
        payloadSha256: DIGEST,
      },
    }]);
    expect(controller.status("alpha")?.identity).toEqual({
      id: "alpha",
      version: "opaque-v2",
      payloadSha256: "d".repeat(64),
    });
    await controller.destroy();
  });

  test("wrong or multiple registration never invokes setup", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    authorize(controller);
    let setupCount = 0;
    const wrong = await controller.applyApproved(input(), () => {
      host.__evaluationEffect = true;
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
    expect(wrong).toMatchObject({
      status: "failed",
      stage: "evaluation",
      possiblePartialEffects: true,
    });
    expect(host.__evaluationEffect).toBe(true);

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
