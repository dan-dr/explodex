import { describe, expect, test } from "bun:test";
import { createLifecycleHarness } from "../../src/testing/index.ts";
import { renderRegisteredPluginOptions } from "../../src/lifecycle/plugin-capabilities.ts";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function createCapabilityHost(): Record<string, unknown> {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    localStorage: createStorage(),
    location: { pathname: "/local/thread-id" },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    __explodexAppServerSend(type: string, payload: Record<string, unknown>) {
      return Promise.resolve({ type, payload });
    },
    __explodexCapabilityTest: {
      listenerCount(type: string) {
        return listeners.get(type)?.size ?? 0;
      },
    },
  };
}

describe("VAL-PLUG-004 and VAL-PLUG-016 plugin capability lifecycle", () => {
  test("declared compatibility capabilities exist and tracked registrations dispose once", async () => {
    const host = createCapabilityHost();
    const harness = createLifecycleHarness({ host });
    let optionsDisposed = 0;
    let migrationRuns = 0;
    let eventCalls = 0;
    let optionRenders = 0;
    let optionClears = 0;

    const applied = await harness.apply("capability-fixture", {
      async setup(api) {
        expect(api.storage.persisted.get("missing", "fallback")).toBe("fallback");
        api.storage.persisted.set("current", { enabled: true });
        api.storage.persisted.set("legacy", { migrated: true });
        await api.migrate([
          {
            id: "rename",
            run({ renameKey }) {
              migrationRuns += 1;
              expect(renameKey("legacy", "renamed")).toBe(true);
            },
          },
        ]);
        expect(
          api.storage.persisted.get<{ migrated: boolean } | null>(
            "renamed",
            null,
          ),
        ).toEqual({ migrated: true });

        api.registerOptions({
          render() {
            optionRenders += 1;
          },
        });
        api.track.subscription(() => {
          optionsDisposed += 1;
        });

        const stop = api.bridge.on("fixture-event", () => {
          eventCalls += 1;
        });
        api.track.subscription(stop);

        expect(api.bridge.isAvailable()).toBe(true);
        expect(
          await api.bridge.send<{
            type: string;
            payload: { value: number };
          }>("fixture-send", { value: 1 }),
        ).toEqual({
          type: "fixture-send",
          payload: { value: 1 },
        });
        expect(typeof api.http.get).toBe("function");
        expect(typeof api.inject.observeZone).toBe("function");
        expect(typeof api.mount).toBe("function");
        expect(typeof api.components.button).toBe("function");
        expect(typeof api.composer.getInput).toBe("function");
        expect(typeof api.ui.popover).toBe("function");
        expect(typeof api.sidebarNav.insertBefore).toBe("function");
        expect(typeof api.flags.propagate).toBe("function");
        expect(typeof api.format.template).toBe("function");
      },
    });

    expect(applied.ok).toBe(true);
    expect(migrationRuns).toBe(1);
    const optionsContainer = {
      isConnected: true,
      replaceChildren() {
        optionClears += 1;
      },
    } as unknown as HTMLElement;
    expect(
      renderRegisteredPluginOptions(
        host,
        "capability-fixture",
        optionsContainer,
      ),
    ).toBe(true);
    expect(optionRenders).toBe(1);
    (host.dispatchEvent as (event: { type: string; data?: unknown }) => boolean)({
      type: "message",
      data: { type: "fixture-event" },
    });
    expect(eventCalls).toBe(1);
    expect(
      (
        host.__explodexCapabilityTest as {
          listenerCount(type: string): number;
        }
      ).listenerCount("message"),
    ).toBe(1);

    await harness.unload("capability-fixture");
    await harness.unload("capability-fixture");
    expect(optionsDisposed).toBe(1);
    expect(optionClears).toBe(1);
    expect(
      renderRegisteredPluginOptions(
        host,
        "capability-fixture",
        optionsContainer,
      ),
    ).toBe(false);
    expect(
      (
        host.__explodexCapabilityTest as {
          listenerCount(type: string): number;
        }
      ).listenerCount("message"),
    ).toBe(0);

    const reapplied = await harness.apply("capability-fixture", {
      async setup(api) {
        await api.migrate([
          {
            id: "rename",
            run() {
              migrationRuns += 1;
            },
          },
        ]);
      },
    });
    expect(reapplied.ok).toBe(true);
    expect(migrationRuns).toBe(1);
  });

  test("private renderer objects are absent from the plugin API", async () => {
    const harness = createLifecycleHarness({ host: createCapabilityHost() });
    const applied = await harness.apply("private-shape", {
      setup(api) {
        const keys = Object.keys(api);
        expect(keys).not.toContain("electronBridge");
        expect(keys).not.toContain("appServer");
        expect(keys).not.toContain("reactFiberRoot");
        expect(keys).not.toContain("walkFibers");
        expect(keys).not.toContain("statsigClients");
        expect(Object.keys(api.codex)).not.toContain("walkFibers");
        expect(Object.keys(api.flags)).not.toContain("getStatsigClients");
      },
    });
    expect(applied.ok).toBe(true);
  });

  test("authenticated HTTP rejects and releases listeners when transport fails", async () => {
    const host = createCapabilityHost();
    host.__explodexAppServerSend = () =>
      Promise.reject(new Error("transport unavailable"));
    const harness = createLifecycleHarness({ host });
    const applied = await harness.apply("http-failure", {
      async setup(api) {
        await expect(api.http.get("/backend-api/usage")).rejects.toThrow(
          "Renderer bridge request failed",
        );
      },
    });
    expect(applied.ok).toBe(true);
    expect(
      (
        host.__explodexCapabilityTest as {
          listenerCount(type: string): number;
        }
      ).listenerCount("message"),
    ).toBe(0);
  });

  test("native bridge RPC falls back through the authenticated HTTP adapter", async () => {
    const host = createCapabilityHost();
    delete host.__explodexAppServerSend;
    const nativeMessages: Array<Record<string, unknown>> = [];
    host.electronBridge = {
      async sendMessageFromView(message: Record<string, unknown>) {
        nativeMessages.push(message);
        if (message.type === "fetch") {
          (
            host.dispatchEvent as (event: {
              type: string;
              data?: unknown;
            }) => boolean
          )({
            type: "message",
            data: {
              type: "fetch-response",
              requestId: message.requestId,
              responseType: "success",
              status: 200,
              headers: {},
              bodyJsonString: JSON.stringify({ value: "persisted" }),
            },
          });
        }
      },
    };
    const harness = createLifecycleHarness({ host });
    const applied = await harness.apply("native-rpc", {
      async setup(api) {
        expect(
          await api.bridge.rpc("get-global-state", {
            params: { key: "fixture" },
          }),
        ).toEqual({ value: "persisted" });
      },
    });
    expect(applied.ok).toBe(true);
    expect(nativeMessages).toHaveLength(1);
    expect(nativeMessages[0]).toMatchObject({
      type: "fetch",
      method: "POST",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({ key: "fixture" }),
    });
    await harness.unload("native-rpc");
  });

  test("Statsig overrides are generation-safe and restore surviving owners", async () => {
    const client = {
      checkGate() {
        return true;
      },
      getFeatureGate(gate: string) {
        return { name: gate, value: true };
      },
      overrideAdapter: null,
    };
    const host = {
      ...createCapabilityHost(),
      __STATSIG__: { firstInstance: client },
    };
    const harness = createLifecycleHarness({ host });

    expect(
      (
        await harness.apply("generation-owner", {
          setup(api) {
            expect(
              api.flags.setStatsigGateOverride("fixture-gate", true),
            ).toBe(true);
          },
        })
      ).ok,
    ).toBe(true);
    expect(client.checkGate("fixture-gate")).toBe(true);

    expect(
      (
        await harness.apply("generation-owner", {
          setup(api) {
            expect(
              api.flags.setStatsigGateOverride("fixture-gate", false),
            ).toBe(true);
          },
        })
      ).ok,
    ).toBe(true);
    expect(client.checkGate("fixture-gate")).toBe(false);

    expect(
      (
        await harness.apply("surviving-owner", {
          setup(api) {
            api.flags.setStatsigGateOverride("fixture-gate", true);
          },
        })
      ).ok,
    ).toBe(true);
    expect(client.checkGate("fixture-gate")).toBe(true);

    await harness.unload("surviving-owner");
    expect(client.checkGate("fixture-gate")).toBe(false);
    await harness.unload("generation-owner");
    expect(client.checkGate("fixture-gate")).toBe(true);
  });

  test("Statsig cleanup releases custom logical owner labels", async () => {
    const client = {
      checkGate() {
        return false;
      },
      getFeatureGate(gate: string) {
        return { name: gate, value: false };
      },
      overrideAdapter: null,
    };
    const harness = createLifecycleHarness({
      host: {
        ...createCapabilityHost(),
        __STATSIG__: { firstInstance: client },
      },
    });
    expect(
      (
        await harness.apply("custom-owner", {
          setup(api) {
            api.flags.setStatsigGateOverride("custom-gate", true, {
              pluginId: "logical-owner",
            });
          },
        })
      ).ok,
    ).toBe(true);
    expect(client.checkGate("custom-gate")).toBe(true);
    await harness.unload("custom-owner");
    expect(client.checkGate("custom-gate")).toBe(false);
  });

  test("failed replacement restores the prior options registration", async () => {
    const host = createCapabilityHost();
    const harness = createLifecycleHarness({ host });
    const renders: string[] = [];
    expect(
      (
        await harness.apply("option-owner", {
          setup(api) {
            api.registerOptions({
              render() {
                renders.push("prior");
              },
            });
          },
        })
      ).ok,
    ).toBe(true);

    const optionsContainer = {
      isConnected: true,
      replaceChildren() {},
    } as unknown as HTMLElement;
    expect(
      renderRegisteredPluginOptions(host, "option-owner", optionsContainer),
    ).toBe(true);
    expect(renders).toEqual(["prior"]);

    const replacement = await harness.apply("option-owner", {
      setup(api) {
        api.registerOptions({
          render() {
            renders.push("replacement");
          },
        });
        throw new Error("replacement failed");
      },
    });
    expect(replacement.ok).toBe(false);
    expect(
      renderRegisteredPluginOptions(host, "option-owner", optionsContainer),
    ).toBe(true);
    expect(renders).toEqual([
      "prior",
      "replacement",
      "prior",
      "prior",
    ]);
  });

  test("shared SDK styles survive replacement until the last generation unloads", async () => {
    let removals = 0;
    let styleNode:
      | {
          id: string;
          textContent: string;
          isConnected: boolean;
          remove(): void;
        }
      | null = null;
    const document = {
      getElementById(id: string) {
        return styleNode?.isConnected && styleNode.id === id
          ? styleNode
          : null;
      },
      createElement() {
        return {
          id: "",
          textContent: "",
          isConnected: false,
          remove() {
            if (!this.isConnected) return;
            this.isConnected = false;
            removals += 1;
          },
        };
      },
      head: {
        appendChild(node: typeof styleNode) {
          if (node !== null) {
            node.isConnected = true;
            styleNode = node;
          }
        },
      },
    } as unknown as Document;
    const harness = createLifecycleHarness({
      host: { document },
    });
    expect(
      (
        await harness.apply("style-owner", {
          setup(api) {
            api.components.metaText("first");
          },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await harness.apply("style-owner", {
          setup(api) {
            api.components.metaText("second");
          },
        })
      ).ok,
    ).toBe(true);
    expect(removals).toBe(0);
    await harness.unload("style-owner");
    expect(removals).toBe(1);
  });
});