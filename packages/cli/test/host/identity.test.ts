import { describe, expect, test } from "bun:test";
import {
  CANONICAL_BUNDLE_ID,
  CANONICAL_BUNDLE_PATH,
  CANONICAL_EXECUTABLE_NAME,
  CANONICAL_SIGNING_TEAM,
  MISSION_BASELINE_APP_BUILD,
  MISSION_BASELINE_APP_VERSION,
} from "../../src/host/constants.ts";
import { inspectHost } from "../../src/host/identity.ts";
import {
  createFixtureAdapters,
  defaultCanonicalBundleOptions,
} from "./fixture-fs.ts";

describe("inspectHost canonical resolution (VAL-HOST-001)", () => {
  test("selects only /Applications/ChatGPT.app with full identity", async () => {
    const { adapters, fs } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions()],
    });

    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.host) throw new Error("expected success");
    expect(result.hostValid).toBe(true);
    expect(result.selected).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);
    expect(result.host.executablePath).toBe(
      `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/${CANONICAL_EXECUTABLE_NAME}`,
    );
    expect(result.host.bundleId).toBe(CANONICAL_BUNDLE_ID);
    expect(result.host.executableName).toBe(CANONICAL_EXECUTABLE_NAME);
    expect(result.host.signingTeam).toBe(CANONICAL_SIGNING_TEAM);
    expect(result.host.appVersion).toBe(MISSION_BASELINE_APP_VERSION);
    expect(result.host.appBuild).toBe(MISSION_BASELINE_APP_BUILD);
    expect(result.host.hostHashes["Contents/Info.plist"]).toMatch(/^[a-f0-9]{64}$/);
    expect(result.host.hostHashes["Contents/MacOS/ChatGPT"]).toMatch(/^[a-f0-9]{64}$/);

    // Read-only: inspection must not write into the host bundle.
    const hostWrites = fs.writeLog.filter((w) => w.path.startsWith(CANONICAL_BUNDLE_PATH));
    expect(hostWrites).toEqual([]);
  });

  test("never selects Codex.app even when present as a fixture", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions(),
        defaultCanonicalBundleOptions({
          bundlePath: "/Applications/Codex.app",
          executableName: "Codex",
        }),
      ],
    });

    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.host) throw new Error("expected success");
    expect(result.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);
    expect(result.host.bundlePath.includes("Codex")).toBe(false);
  });

  test("rejects a renamed duplicate that does not resolve to the canonical path", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          bundlePath: "/Users/me/Applications/ChatGPT.app",
        }),
      ],
    });

    const result = await inspectHost({
      adapters,
      bundlePath: "/Users/me/Applications/ChatGPT.app",
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_not_canonical_path");
    expect(result.selected).toBe(false);
    expect(result.host).toBeNull();
  });
});

describe("inspectHost failure matrix (VAL-HOST-002)", () => {
  test("missing host fails closed", async () => {
    const { adapters } = createFixtureAdapters({ bundles: [] });
    // Empty fs — no bundle seeded.
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_missing");
    expect(result.error.failedPredicates).toContain("bundle_exists");
    expect(result.selected).toBe(false);
  });

  test("malformed bundle structure fails closed", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ omit: ["infoPlist"] })],
    });
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_malformed");
    expect(result.error.failedPredicates).toContain("info_plist");
  });

  test("wrong bundle id fails closed", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ bundleId: "com.example.other" })],
    });
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_wrong_identity");
    expect(result.error.failedPredicates).toContain("cf_bundle_identifier");
  });

  test("wrong executable name fails closed", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ executableName: "Codex" })],
    });
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_wrong_identity");
    expect(result.error.failedPredicates).toContain("cf_bundle_executable");
  });

  test("broken executable relationship (escape) fails closed", async () => {
    const outside = "/tmp/foreign-bin/ChatGPT";
    const { adapters, fs } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          executableAbsolutePath: outside,
          realpathMap: {
            [CANONICAL_BUNDLE_PATH]: CANONICAL_BUNDLE_PATH,
            [`${CANONICAL_BUNDLE_PATH}/Contents/MacOS/ChatGPT`]: outside,
          },
        }),
      ],
    });
    // Also seed the declared path as a symlink-like realpath target outside.
    fs.seedFile(`${CANONICAL_BUNDLE_PATH}/Contents/MacOS/ChatGPT`, "stub");
    fs.setRealpath(`${CANONICAL_BUNDLE_PATH}/Contents/MacOS/ChatGPT`, outside);

    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_broken_executable_relationship");
    expect(result.error.failedPredicates).toContain("executable_inside_bundle");
  });

  test("invalid signing team fails closed", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ signingTeam: "AAAAAAAAAA" })],
    });
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_invalid_signature");
    expect(result.error.failedPredicates).toContain("signing_team");
  });

  test("failure selects none and leaves candidates unchanged (no writes)", async () => {
    const { adapters, fs } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ signingTeam: "BADTEAM0000" })],
    });
    const beforeKeys = [...fs.entries.keys()].sort();
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(false);
    expect(result.selected).toBe(false);
    const afterKeys = [...fs.entries.keys()].sort();
    expect(afterKeys).toEqual(beforeKeys);
    expect(fs.writeLog).toEqual([]);
  });
});

describe("inspectHost identity reporting (VAL-HOST-003)", () => {
  test("reports version and build separately from compatibility", async () => {
    const { adapters } = createFixtureAdapters({});
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.host) throw new Error("expected success");
    expect(result.host.appVersion).toBe(MISSION_BASELINE_APP_VERSION);
    expect(result.host.appBuild).toBe(MISSION_BASELINE_APP_BUILD);
    // Structural validity must not claim proven compatibility.
    expect(result.compatibility.status).not.toBe("proven");
    expect(result.compatibility.allowsCompatibilityDependentWork).toBe(false);
  });

  test("structurally valid unknown build remains hostValid but is not baseline 5628", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "99.0.0",
          appBuild: "9999",
        }),
      ],
    });
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.host) throw new Error("expected success");
    expect(result.hostValid).toBe(true);
    expect(result.host.appBuild).toBe("9999");
    expect(result.host.appBuild).not.toBe(MISSION_BASELINE_APP_BUILD);
    expect(result.compatibility.status).toBe("unproven");
    expect(result.compatibility.allowsCompatibilityDependentWork).toBe(false);
  });

  test("host identity is reportable without requiring a running process or CDP", async () => {
    const { adapters } = createFixtureAdapters({});
    const result = await inspectHost({
      adapters,
      bundlePath: CANONICAL_BUNDLE_PATH,
      requireCanonicalPath: true,
    });
    expect(result.ok).toBe(true);
    // No CDP or process fields are required on the success path.
    expect("cdp" in result).toBe(false);
    expect(result.readOnly).toBe(true);
  });
});
