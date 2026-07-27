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

  test.each([
    {
      name: "DOM mutation",
      source: 'document.body.appendChild(document.createElement("div"));',
      field: "domMutations",
    },
    {
      name: "DOM property mutation",
      source: 'document.body.innerHTML = "<div>blocked</div>";',
      field: "domMutations",
    },
    {
      name: "document property mutation",
      source: 'document.title = "blocked";',
      field: "domMutations",
    },
    {
      name: "text-node property mutation",
      source: 'document.createTextNode("before").textContent = "blocked";',
      field: "domMutations",
    },
    {
      name: "network request",
      source: 'fetch("https://example.invalid/inert");',
      field: "networkCalls",
    },
    {
      name: "storage mutation",
      source: 'localStorage.setItem("inert", "blocked");',
      field: "storageMutations",
    },
    {
      name: "timer registration",
      source: "setTimeout(() => {}, 1);",
      field: "timerRegistrations",
    },
    {
      name: "host action",
      source: 'electronBridge.sendMessageFromView({ type: "blocked" });',
      field: "hostActions",
    },
    {
      name: "global mutation",
      source: "globalThis.inertMutation = true;",
      field: "globalMutations",
    },
  ])("directly observes and rejects top-level $name", async ({ source, field }) => {
    const harness = createInertRegistrationHarness();
    const result = await harness.evaluateSource({
      expectedPluginId: "sample",
      source: `
        ${source}
        globalThis.__EXPLODEX_PRIVATE_REGISTER__("sample", { setup() {} });
      `,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("plugin.registration.side-effect");
    expect(result.sideEffects[field as keyof typeof result.sideEffects]).toBeGreaterThan(0);
  });

  test("caller-declared side-effect counters are not an acceptance input", async () => {
    const harness = createInertRegistrationHarness();
    const options: Parameters<typeof harness.evaluateSource>[0] & {
      sideEffects?: { domMutations: number };
    } = {
      expectedPluginId: "sample",
      source: 'globalThis.__EXPLODEX_PRIVATE_REGISTER__("sample", { setup() {} });',
      sideEffects: { domMutations: 100 },
    };
    const result = await harness.evaluateSource(options);
    expect(result.ok).toBe(true);
  });

  test("drains top-level microtasks before accepting inert registration", async () => {
    const harness = createInertRegistrationHarness();
    const result = await harness.evaluateSource({
      expectedPluginId: "sample",
      source: `
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => fetch("https://example.invalid/deferred"));
        globalThis.__EXPLODEX_PRIVATE_REGISTER__("sample", { setup() {} });
      `,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected deferred side-effect failure");
    expect(result.code).toBe("plugin.registration.side-effect");
    expect(result.sideEffects.timerRegistrations).toBeGreaterThan(0);
  });

  test("drains async-function intrinsic microtasks before acceptance", async () => {
    const harness = createInertRegistrationHarness();
    const result = await harness.evaluateSource({
      expectedPluginId: "sample",
      source: `
        (async () => {
          await 0;
          await 0;
          fetch("https://example.invalid/async");
        })();
        globalThis.__EXPLODEX_PRIVATE_REGISTER__("sample", { setup() {} });
      `,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected async side-effect failure");
    expect(result.code).toBe("plugin.registration.side-effect");
    expect(result.sideEffects.networkCalls).toBe(1);
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
