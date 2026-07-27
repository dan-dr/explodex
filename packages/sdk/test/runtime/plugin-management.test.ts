import { describe, expect, test } from "bun:test";
import {
  buildPluginManagementModel,
  type PluginManagementRequest,
} from "../../src/runtime/plugin-management.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

function request(): PluginManagementRequest {
  return {
    schemaVersion: 1,
    target: "main",
    plugins: [{
      id: "alpha",
      displayName: "Alpha",
      description: "Management handoff fixture",
      installed: [{
        version: "opaque A",
        payloadSha256: A,
      }, {
        version: "opaque-B",
        payloadSha256: B,
      }],
      enabled: {
        version: "opaque A",
        payloadSha256: A,
      },
      pendingReview: [{
        version: "opaque-B",
        payloadSha256: B,
      }],
      application: {
        status: "unknown",
        lifecycle: "renderer-start",
        boundary: "renderer",
        observedIdentity: null,
        message:
          "No exact renderer application state was inspected by the completed operation.",
      },
    }],
  };
}

describe("M3-F08 honest post-exit plugin management", () => {
  test("renders command-only bounded handoffs with exact identities", () => {
    const model = buildPluginManagementModel(request());
    expect(model.ok).toBe(true);
    if (!model.ok) throw new Error(model.message);
    expect(model.hasResidentListener).toBe(false);
    expect(model.plugins).toHaveLength(1);
    const plugin = model.plugins[0]!;
    expect(plugin.persistedIntent).toEqual({
      status: "enabled",
      identity: {
        version: "opaque A",
        payloadSha256: A,
      },
    });
    expect(plugin.application).toEqual(request().plugins[0]!.application);
    expect(plugin.controls.map((control) => control.action)).toEqual([
      "enable",
      "review",
      "refresh",
      "update",
      "disable",
      "remove",
    ]);
    expect(plugin.controls.every((control) =>
      control.handoff === "exact-public-command" &&
      control.authorityMutation === "none" &&
      control.successClaim === "none"
    )).toBe(true);
    expect(plugin.controls.find((control) => control.action === "enable")?.command)
      .toBe(
        `explodex plugin review alpha --artifact-version opaque-B --payload-sha256 ${B} --target main`,
      );
    expect(plugin.controls.find((control) => control.action === "review")?.command)
      .toBe(
        `explodex plugin review alpha --artifact-version opaque-B --payload-sha256 ${B} --target main`,
      );
    expect(plugin.controls.find((control) => control.action === "refresh")?.command)
      .toBe("explodex plugin refresh --target main");
    expect(plugin.controls.find((control) => control.action === "update")?.command)
      .toBe("explodex plugin update check");
    expect(plugin.controls.find((control) => control.action === "disable")?.command)
      .toBe("explodex plugin disable alpha --target main");
    expect(plugin.controls.find((control) => control.action === "remove")?.command)
      .toBe(
        `explodex plugin remove alpha --artifact-version 'opaque A' --payload-sha256 ${A} --target main`,
      );
  });

  test("rejects malformed metadata and never exposes a callback or direct mutation hook", () => {
    const malformed = {
      ...request(),
      plugins: [{
        ...request().plugins[0],
        executableSource: "globalThis.__SHOULD_NEVER_ENTER_MANAGEMENT__ = true",
      }],
    };
    const result = buildPluginManagementModel(malformed);
    expect(result.ok).toBe(false);

    const valid = buildPluginManagementModel(request());
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error(valid.message);
    expect(JSON.stringify(valid)).not.toContain("callbackName");
    expect(JSON.stringify(valid)).not.toContain("listenerUrl");
    expect(JSON.stringify(valid)).not.toContain("__SHOULD_NEVER_ENTER_MANAGEMENT__");
    expect(valid.plugins[0]?.application.status).toBe("unknown");
  });
});
