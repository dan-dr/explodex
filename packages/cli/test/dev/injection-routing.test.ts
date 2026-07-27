import { describe, expect, test } from "bun:test";
import {
  executeDevArtifactRoute,
  routeDevArtifactLifecycle,
  type DevArtifactRouteAction,
} from "../../src/dev/index.ts";

describe("M4-F03 ephemeral development injection routing", () => {
  test("routes each lifecycle to its only permitted owned-development boundary", () => {
    expect(routeDevArtifactLifecycle("dynamic")).toBe("dynamic");
    expect(routeDevArtifactLifecycle("renderer-start")).toBe(
      "renderer-boundary",
    );
    expect(routeDevArtifactLifecycle("app-start")).toBe("app-boundary");
  });

  test("executes exactly one route and never falls back to another target", async () => {
    for (const testCase of [
      {
        lifecycle: "dynamic" as const,
        expected: ["dynamic:dynamic"],
      },
      {
        lifecycle: "renderer-start" as const,
        expected: ["renderer-boundary:renderer"],
      },
      {
        lifecycle: "app-start" as const,
        expected: ["app-boundary:app"],
      },
    ]) {
      const calls: string[] = [];
      const actions: Record<DevArtifactRouteAction, () => Promise<string>> = {
        dynamic: async () => {
          calls.push("dynamic:dynamic");
          return "dynamic";
        },
        "renderer-boundary": async () => {
          calls.push("renderer-boundary:renderer");
          return "renderer";
        },
        "app-boundary": async () => {
          calls.push("app-boundary:app");
          return "app";
        },
      };
      const result = await executeDevArtifactRoute({
        lifecycle: testCase.lifecycle,
        actions,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.route).toBe(routeDevArtifactLifecycle(testCase.lifecycle));
      }
      expect(calls).toEqual(testCase.expected);
    }
  });

  test("route failure is terminal and does not invoke another route", async () => {
    const calls: string[] = [];
    const result = await executeDevArtifactRoute({
      lifecycle: "renderer-start",
      actions: {
        dynamic: async () => {
          calls.push("dynamic");
          return "unexpected";
        },
        "renderer-boundary": async () => {
          calls.push("renderer");
          throw Object.assign(new Error("renderer context drifted"), {
            code: "context_identity_drift",
          });
        },
        "app-boundary": async () => {
          calls.push("app");
          return "unexpected";
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      route: "renderer-boundary",
      code: "context_identity_drift",
      message: "renderer context drifted",
    });
    expect(calls).toEqual(["renderer"]);
  });
});
