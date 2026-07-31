import { describe, expect, test } from "bun:test";
import {
  buildFingerprint,
  emptyBundleGateCache,
  extractGateMappingsFromSource,
  isCacheFresh,
  runBundleGateScan,
  type BundleScanEnvironment,
} from "../src/bundle-gate-scan.ts";

describe("VAL-PLUG-013 Feature Flags Playground bundle scanner", () => {
  test("discovers direct, alias, and nearby feature gate mappings", () => {
    const result = extractGateMappingsFromSource("const feature=`chronicle`; gateName:`2574306096`,featureKey:feature; [`browser_use`]:ln(x,`410262010`); checkGate(`1506311413`); `computer_use`");
    expect(result.mappings.chronicle?.[0]?.gateId).toBe("2574306096");
    expect(result.mappings.browser_use?.[0]?.gateId).toBe("410262010");
    expect(result.mappings.computer_use?.[0]?.gateId).toBe("1506311413");
  });

  test("keeps a matching build cache and preserves prior mappings on rescans", async () => {
    const env: BundleScanEnvironment = {
      fetch: async () => ({ ok: true, text: async () => "[`browser_use`]:ln(x,`410262010`)" }),
      locationHref: "app://-/index.html",
      loadedUrls: () => ["app://-/assets/index-live.js"],
      codexVersion: () => "26.8",
    };
    const fingerprint = buildFingerprint(env.loadedUrls(), env.locationHref, env.codexVersion());
    const cache = { ...emptyBundleGateCache(), scannedAt: Date.now(), buildFingerprint: fingerprint, mappings: { chronicle: ["2574306096"] } };
    expect(isCacheFresh(cache, fingerprint)).toBe(true);
    const result = await runBundleGateScan({ cache, env, force: true });
    expect(result.cache.mappings).toEqual({ chronicle: ["2574306096"], browser_use: ["410262010"] });
  });
});
