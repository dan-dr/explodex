import { describe, expect, test } from "bun:test";
import {
  createInertRegistrationHarness,
  createLifecycleHarness,
  PRIVATE_REGISTER_GLOBAL,
} from "../../src/testing/index.ts";
import { definePlugin } from "../../src/define-plugin.ts";

describe("VAL-SDK-018 inert definition registration", () => {
  test("evaluation registers exactly one definition and performs no setup", () => {
    let setupCalls = 0;
    const harness = createInertRegistrationHarness();
    const definition = definePlugin({
      setup() {
        setupCalls += 1;
      },
    });

    const result = harness.evaluate({
      expectedPluginId: "sample",
      evaluate() {
        const register = harness.host[PRIVATE_REGISTER_GLOBAL];
        expect(typeof register).toBe("function");
        (register as (id: string, def: unknown) => void)("sample", definition);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.registrationCount).toBe(1);
    expect(result.registration.pluginId).toBe("sample");
    expect(typeof result.registration.definition.setup).toBe("function");
    expect(setupCalls).toBe(0);
    expect(result.sideEffects.setupCalls).toBe(0);
  });

  test("zero registrations fail load", () => {
    const harness = createInertRegistrationHarness();
    const result = harness.evaluate({
      expectedPluginId: "sample",
      evaluate() {
        // intentionally no registration
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("plugin.registration.none");
    expect(result.registrationCount).toBe(0);
  });

  test("multiple registrations fail load", () => {
    const harness = createInertRegistrationHarness();
    const def = definePlugin({ setup() {} });
    const result = harness.evaluate({
      expectedPluginId: "sample",
      evaluate() {
        const register = harness.host[PRIVATE_REGISTER_GLOBAL] as (
          id: string,
          def: unknown,
        ) => void;
        register("sample", def);
        register("sample", def);
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("plugin.registration.multiple");
    expect(result.registrationCount).toBe(2);
  });

  test("ID mismatch fails load", () => {
    const harness = createInertRegistrationHarness();
    const def = definePlugin({ setup() {} });
    const result = harness.evaluate({
      expectedPluginId: "expected-id",
      evaluate() {
        const register = harness.host[PRIVATE_REGISTER_GLOBAL] as (
          id: string,
          def: unknown,
        ) => void;
        register("other-id", def);
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("plugin.registration.id-mismatch");
  });

  test("registration outside private phase fails", () => {
    const harness = createInertRegistrationHarness();
    const def = definePlugin({ setup() {} });
    expect(() => harness.controller.register("sample", def)).toThrow(/private evaluation phase/);

    // Classic source that tries to register without phase should fail when evaluated
    // without harness private hooks.
    const bare = createInertRegistrationHarness();
    expect(bare.host[PRIVATE_REGISTER_GLOBAL]).toBeUndefined();
  });

  test("side effects during evaluation fail inert registration", () => {
    const harness = createInertRegistrationHarness();
    const def = definePlugin({ setup() {} });
    const result = harness.evaluate({
      expectedPluginId: "sample",
      sideEffects: { setupCalls: 1 },
      evaluate() {
        const register = harness.host[PRIVATE_REGISTER_GLOBAL] as (
          id: string,
          def: unknown,
        ) => void;
        register("sample", def);
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("plugin.registration.side-effect");
  });

  test("failed setup never leaves catalog as successfully applied", async () => {
    const lifecycle = createLifecycleHarness();
    const apply = await lifecycle.apply("sample", {
      setup() {
        throw new Error("boom");
      },
    });
    expect(apply.ok).toBe(false);
    if (apply.ok) throw new Error("expected failure");
    expect(apply.record.status).toBe("failed");
    expect(lifecycle.host.get("sample")?.status).toBe("failed");
    expect(lifecycle.host.get("sample")?.status).not.toBe("applied");
  });

  test("public harness does not expose a general activation setter", () => {
    const harness = createInertRegistrationHarness();
    const keys = Object.keys(harness.host);
    expect(keys.includes("enablePlugin")).toBe(false);
    expect(keys.includes("setEnabled")).toBe(false);
    expect(keys.includes("activate")).toBe(false);
  });
});
