import { describe, expect, test } from "bun:test";
import {
  createPluginAssetStore,
  createPluginLifecycleHost,
} from "../../src/lifecycle/index.ts";
import type { PluginAssetHandle } from "../../src/types/plugin.ts";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function requireAssetHandle(
  handle: PluginAssetHandle | null,
  message: string,
): PluginAssetHandle {
  if (handle === null) throw new Error(message);
  return handle;
}

describe("VAL-SDK-022 scoped immutable plugin assets", () => {
  test("delivers declared text, binary, and nested bytes without sharing backing storage", async () => {
    const store = createPluginAssetStore({
      pluginId: "alpha",
      assets: new Map([
        ["assets/notice.txt", bytes("trusted notice")],
        ["assets/nested/data.bin", new Uint8Array([0, 1, 2, 255])],
      ]),
    });
    const host = createPluginLifecycleHost();
    let notice: PluginAssetHandle | null = null;
    let binary: PluginAssetHandle | null = null;
    const applied = await host.apply({
      pluginId: "alpha",
      definition: {
        async setup(api) {
          notice = await api.assets.open("notice.txt");
          binary = await api.assets.open("nested/data.bin");
        },
      },
      assets: store,
    });
    expect(applied.ok).toBe(true);
    const openedNotice = requireAssetHandle(
      notice,
      "expected setup to open the notice asset",
    );
    const openedBinary = requireAssetHandle(
      binary,
      "expected setup to open the binary asset",
    );
    expect(await openedNotice.text()).toBe("trusted notice");
    const first = await openedBinary.bytes();
    const second = await openedBinary.bytes();
    expect([...first]).toEqual([0, 1, 2, 255]);
    expect(first).not.toBe(second);
    first[0] = 99;
    expect([...(await openedBinary.bytes())]).toEqual([0, 1, 2, 255]);
  });

  test("rejects unknown, undeclared, traversal, absolute, and cross-plugin requests", async () => {
    const alpha = createPluginAssetStore({
      pluginId: "alpha",
      assets: new Map([["assets/only-alpha.txt", bytes("alpha")]]),
    });
    const beta = createPluginAssetStore({
      pluginId: "beta",
      assets: new Map([["assets/only-beta.txt", bytes("beta")]]),
    });
    const rejected = [
      alpha.open("missing.txt"),
      alpha.open("../only-beta.txt"),
      alpha.open("/absolute.txt"),
      alpha.open("assets/only-alpha.txt"),
      alpha.open("only-beta.txt"),
      beta.open("only-alpha.txt"),
    ];
    for (const result of rejected) {
      await expect(result).rejects.toThrow(/asset request/i);
    }
  });

  test("unload revokes every open handle and prevents later opens", async () => {
    const store = createPluginAssetStore({
      pluginId: "alpha",
      assets: new Map([["assets/notice.txt", bytes("revocable")]]),
    });
    const host = createPluginLifecycleHost();
    let handle: PluginAssetHandle | null = null;
    const applied = await host.apply({
      pluginId: "alpha",
      definition: {
        async setup(api) {
          handle = await api.assets.open("notice.txt");
        },
      },
      assets: store,
    });
    expect(applied.ok).toBe(true);
    expect(applied.record.resources.assets).toBe(2);
    const opened = requireAssetHandle(
      handle,
      "expected setup to open an asset handle",
    );
    expect(await opened.text()).toBe("revocable");

    const unloaded = await host.unload({ pluginId: "alpha" });
    expect(unloaded?.record.resources.assets).toBe(0);
    await expect(opened.bytes()).rejects.toThrow(/revoked/i);
    await expect(store.open("notice.txt")).rejects.toThrow(/revoked/i);
  });
});
