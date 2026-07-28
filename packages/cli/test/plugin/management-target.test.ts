import { describe, expect, test } from "bun:test";
import {
  parsePluginManagementResponse,
  type PluginManagementObservation,
} from "../../src/plugin/management-target.ts";

const DIGEST = "a".repeat(64);
const LOCAL: PluginManagementObservation = {
  id: "alpha",
  displayName: "Alpha",
  description: "Authoritative local metadata",
  installed: [{ version: "v1", payloadSha256: DIGEST }],
  enabled: { version: "v1", payloadSha256: DIGEST },
  pendingReview: [],
  application: {
    status: "unknown",
    lifecycle: "dynamic",
    boundary: "none",
    observedIdentity: null,
    message: "Not inspected.",
  },
};

describe("M4-F03 management target response correlation", () => {
  test("accepts only observed application facts for the exact local record", () => {
    const parsed = parsePluginManagementResponse({
      ok: true,
      plugins: [{
        ...LOCAL,
        application: {
          status: "applied",
          lifecycle: "dynamic",
          boundary: "none",
          observedIdentity: { version: "v1", payloadSha256: DIGEST },
          message: "Applied.",
        },
      }],
      uiOpened: true,
    }, [LOCAL]);
    expect(parsed).toMatchObject({
      ok: true,
      plugins: [{
        id: "alpha",
        displayName: "Alpha",
        application: { status: "applied" },
      }],
      uiOpened: true,
    });
  });

  test("rejects renderer-substituted or omitted persisted plugin state", () => {
    for (const plugins of [
      [{ ...LOCAL, displayName: "Spoofed" }],
      [],
      [LOCAL, { ...LOCAL, id: "beta" }],
    ]) {
      expect(parsePluginManagementResponse({
        ok: true,
        plugins,
        uiOpened: false,
      }, [LOCAL])).toBeNull();
    }
  });

  test("rejects impossible installed, enabled, lifecycle, and boundary claims", () => {
    const invalidApplications = [
      {
        status: "applied",
        lifecycle: "dynamic",
        boundary: "none",
        observedIdentity: {
          version: "foreign",
          payloadSha256: "b".repeat(64),
        },
        message: "Foreign identity.",
      },
      {
        status: "boundary-required",
        lifecycle: "dynamic",
        boundary: "renderer",
        observedIdentity: null,
        message: "Impossible dynamic boundary.",
      },
      {
        status: "applied",
        lifecycle: "renderer-start",
        boundary: "none",
        observedIdentity: LOCAL.enabled,
        message: "Wrong lifecycle.",
      },
    ] as const;
    for (const application of invalidApplications) {
      expect(parsePluginManagementResponse({
        ok: true,
        plugins: [{ ...LOCAL, application }],
        uiOpened: false,
      }, [LOCAL])).toBeNull();
    }
  });
});
