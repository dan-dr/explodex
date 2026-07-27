import { describe, expect, test } from "bun:test";
import { PRIVATE_REGISTER_GLOBAL } from "../../src/lifecycle/index.ts";
import {
  createPluginApplicationController,
} from "../../src/runtime/plugin-application.ts";

function input(id: string, digest: string) {
  return {
    schemaVersion: 1,
    operationId: `reconcile-${id}`,
    nonce: `nonce-${id}`,
    id,
    version: "opaque-v1",
    payloadSha256: digest,
    lifecycle: "dynamic",
    assets: [],
  };
}

describe("M3-F08 delta teardown and full-refresh preservation", () => {
  test("exact unload affects only the named live identity", async () => {
    const host: Record<string, unknown> = {};
    const controller = createPluginApplicationController({ host });
    const setup = new Map<string, number>();
    const teardown = new Map<string, number>();
    const apply = async (id: string, digest: string) =>
      controller.reconcileEnabled(input(id, digest), () => {
        const register = host[PRIVATE_REGISTER_GLOBAL] as (
          pluginId: string,
          definition: unknown,
        ) => void;
        register(id, {
          setup() {
            setup.set(id, (setup.get(id) ?? 0) + 1);
            return () => {
              teardown.set(id, (teardown.get(id) ?? 0) + 1);
            };
          },
        });
      });

    const alphaDigest = "a".repeat(64);
    const betaDigest = "b".repeat(64);
    expect((await apply("alpha", alphaDigest)).status).toBe("applied");
    expect((await apply("beta", betaDigest)).status).toBe("applied");
    const betaBefore = controller.status("beta");

    const unloaded = await controller.unload("alpha");
    expect(unloaded?.teardownInvoked).toBe(true);
    expect(controller.status("alpha")).toBeNull();
    expect(controller.status("beta")).toEqual(betaBefore);
    expect(setup).toEqual(new Map([
      ["alpha", 1],
      ["beta", 1],
    ]));
    expect(teardown).toEqual(new Map([["alpha", 1]]));

    expect((await apply("beta", betaDigest)).status).toBe("unchanged");
    expect(setup.get("beta")).toBe(1);
    expect(teardown.get("beta")).toBeUndefined();
    await controller.destroy();
    expect(teardown.get("beta")).toBe(1);
  });
});
