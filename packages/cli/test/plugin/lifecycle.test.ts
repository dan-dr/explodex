import { describe, expect, test } from "bun:test";
import { canHotSetup, normalizeLifecycle } from "../../src/plugin/lifecycle.ts";

describe("VAL-SDK-015 exact lifecycle normalization", () => {
  test("accepts only dynamic, renderer-start, and app-start unchanged", () => {
    for (const lifecycle of ["dynamic", "renderer-start", "app-start"] as const) {
      const result = normalizeLifecycle(lifecycle);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.lifecycle).toBe(lifecycle);
    }
  });

  test("rejects missing, unknown, and legacy loadable/unloadable combinations", () => {
    for (const lifecycle of [
      undefined,
      null,
      "",
      "loadable",
      "unloadable",
      "always",
      "never",
      "hot",
      "static",
      1,
    ]) {
      const result = normalizeLifecycle(lifecycle);
      expect(result.ok).toBe(false);
    }
  });

  test("hot setup is only allowed for dynamic; restart lifecycles report boundary", () => {
    const dynamic = normalizeLifecycle("dynamic");
    expect(dynamic.ok).toBe(true);
    if (dynamic.ok) {
      expect(dynamic.hotSetupAllowed).toBe(true);
      expect(dynamic.requiredBoundary).toBe("current");
      expect(canHotSetup(dynamic.lifecycle)).toBe(true);
    }

    const renderer = normalizeLifecycle("renderer-start");
    expect(renderer.ok).toBe(true);
    if (renderer.ok) {
      expect(renderer.hotSetupAllowed).toBe(false);
      expect(renderer.requiredBoundary).toBe("renderer-start");
      expect(canHotSetup(renderer.lifecycle)).toBe(false);
    }

    const app = normalizeLifecycle("app-start");
    expect(app.ok).toBe(true);
    if (app.ok) {
      expect(app.hotSetupAllowed).toBe(false);
      expect(app.requiredBoundary).toBe("app-start");
      expect(canHotSetup(app.lifecycle)).toBe(false);
    }
  });
});
