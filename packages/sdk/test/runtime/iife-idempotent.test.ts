import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserRealm } from "../helpers/browser-realm.ts";
import { buildSdkPackage, SDK_PACKAGE_ROOT } from "../helpers/pack.ts";

describe("VAL-SDK-004 renderer IIFE is self-contained and idempotent", () => {
  test("classic IIFE initializes once and converges on one runtime instance", async () => {
    await buildSdkPackage();
    const iifePath = join(
      SDK_PACKAGE_ROOT,
      "dist",
      "runtime",
      "explodex-runtime.iife.js",
    );
    const source = await readFile(iifePath, "utf8");

    // Format scan: classic script, not ESM/CJS loader dependent.
    expect(/^\s*import\s/m.test(source)).toBe(false);
    expect(source.includes("require(")).toBe(false);
    expect(source.includes("module.exports")).toBe(false);
    expect(source.includes("process.")).toBe(false);
    expect(source.includes("Buffer.")).toBe(false);
    expect(source.includes("__explodexApplyApprovedPayload")).toBe(true);

    const realm = createBrowserRealm();
    // Forbidden globals must be absent.
    for (const key of ["process", "Buffer", "require", "module", "exports", "Bun", "electron"]) {
      expect(key in realm.global).toBe(false);
    }

    realm.evaluate(source);
    const first = realm.global.Explodex;
    expect(first).toBeDefined();
    expect(typeof first?.version).toBe("string");
    expect(first?.version.length).toBeGreaterThan(0);
    expect(typeof first?.destroy).toBe("function");
    expect(typeof first?.log.info).toBe("function");

    realm.evaluate(source);
    const second = realm.global.Explodex;
    expect(second).toBe(first);
    expect(realm.uncaughtErrors).toEqual([]);

    // Only one version sentinel remains.
    const versions = [realm.global.Explodex?.version];
    expect(versions).toEqual([first?.version]);

    let legacyDestroyed = 0;
    const legacyRealm = createBrowserRealm();
    const legacy = {
      version: first?.version,
      destroy() {
        legacyDestroyed += 1;
      },
      review: {
        open() {
          return Promise.resolve({ status: "cancelled", reason: "legacy" });
        },
        cancel() {},
      },
      __explodexSdkRuntimeMark: first?.version,
    };
    legacyRealm.global.Explodex = legacy as never;
    legacyRealm.global["__explodexSdkRuntimeInstance"] = legacy;
    legacyRealm.evaluate(source);
    expect(legacyRealm.global.Explodex).not.toBe(legacy);
    expect(legacyDestroyed).toBe(1);
    expect(
      typeof (legacyRealm.global.Explodex as unknown as Record<string, unknown>)[
        "__explodexApplyApprovedPayload"
      ],
    ).toBe("function");
  }, 120_000);
});
