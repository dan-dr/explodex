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
import { reportHost } from "../../src/host/report.ts";
import {
  createFixtureAdapters,
  defaultCanonicalBundleOptions,
} from "./fixture-fs.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("inspectHost canonical resolution (VAL-HOST-001)", () => {
  test("selects only /Applications/ChatGPT.app with full identity", async () => {
    const { adapters, fs } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions()],
    });

    const result = await inspectHost({ adapters });

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
    expect(result.host.hostHashes["Contents/Resources/app.asar"]).toMatch(/^[a-f0-9]{64}$/);

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

    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.host) throw new Error("expected success");
    expect(result.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);
    expect(result.host.bundlePath.includes("Codex")).toBe(false);
  });

  test("production path never inspects a renamed duplicate outside the canonical path", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          bundlePath: "/Users/me/Applications/ChatGPT.app",
        }),
      ],
    });

    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_missing");
    expect(result.selected).toBe(false);
    expect(result.host).toBeNull();
  });

  test("ignores valid-looking alternate bundles and selects only the canonical path", async () => {
    const alternate = "/Users/me/Applications/ChatGPT.app";
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions(),
        defaultCanonicalBundleOptions({ bundlePath: alternate }),
      ],
    });

    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.host) throw new Error("expected success");
    expect(result.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);
    expect(result.host.bundlePath).not.toBe(alternate);
  });

  test("public production APIs ignore forged noncanonical path overrides", async () => {
    const alternate = "/Users/me/Applications/ChatGPT.app";
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions(),
        defaultCanonicalBundleOptions({ bundlePath: alternate }),
      ],
    });

    const forged = {
      adapters,
      bundlePath: alternate,
      requireCanonicalPath: false,
      testOnly: {
        authority: Symbol.for("explodex.host.test-inspection"),
        bundlePath: alternate,
        requireCanonicalPath: false,
      },
      inspect: { bundlePath: alternate, requireCanonicalPath: false },
    };
    const direct = await inspectHost(forged as Parameters<typeof inspectHost>[0]);
    expect(direct.ok).toBe(true);
    if (!direct.ok || !direct.host) throw new Error("expected canonical success");
    expect(direct.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);

    const reported = await reportHost({
      adapters,
      explodexHome: "/tmp/explodex-host-report-canonical",
      sdkRuntime: { version: "0.0.0-test", sha256: "a".repeat(64) },
      ...(forged as object),
    } as Parameters<typeof reportHost>[0]);
    expect(reported.ok).toBe(true);
    if (!reported.ok || !reported.host) throw new Error("expected report success");
    expect(reported.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);
  });

  test("shipped host identity has no alternate-bundle override surface", () => {
    const identitySource = readFileSync(
      join(import.meta.dir, "../../src/host/identity.ts"),
      "utf8",
    );
    const hostIndexSource = readFileSync(
      join(import.meta.dir, "../../src/host/index.ts"),
      "utf8",
    );
    expect(identitySource).not.toContain("Symbol.for");
    expect(identitySource).not.toContain("HOST_TEST_INSPECTION_AUTHORITY");
    expect(identitySource).not.toContain("inspectHostForTests");
    expect(identitySource).not.toContain("testOnly");
    expect(identitySource).not.toContain("bundlePath?:");
    expect(hostIndexSource).not.toContain("inspectHostForTests");
    expect(hostIndexSource).not.toContain("HOST_TEST_INSPECTION_AUTHORITY");
  });

  test("fixture inspection maps the canonical path through adapters only", async () => {
    // Controlled tests seed fixture content at the canonical path rather than
    // using any production alternate-bundle override.
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          appVersion: "1.2.3-fixture",
          appBuild: "999",
        }),
      ],
    });
    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.host) throw new Error("expected fixture success");
    expect(result.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);
    expect(result.host.appVersion).toBe("1.2.3-fixture");
    expect(result.host.appBuild).toBe("999");
  });
});

describe("inspectHost failure matrix (VAL-HOST-002)", () => {
  test("missing host fails closed", async () => {
    const { adapters } = createFixtureAdapters({ bundles: [] });
    // Empty fs — no bundle seeded.
    const result = await inspectHost({ adapters });
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
    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_malformed");
    expect(result.error.failedPredicates).toContain("info_plist");
  });

  test("wrong bundle id fails closed", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ bundleId: "com.example.other" })],
    });
    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_wrong_identity");
    expect(result.error.failedPredicates).toContain("cf_bundle_identifier");
  });

  test("wrong executable name fails closed", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ executableName: "Codex" })],
    });
    const result = await inspectHost({ adapters });
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

    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_broken_executable_relationship");
    expect(result.error.failedPredicates).toContain("executable_inside_bundle");
  });

  test("invalid signing team fails closed", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ signingTeam: "AAAAAAAAAA" })],
    });
    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_invalid_signature");
    expect(result.error.failedPredicates).toContain("signing_team");
  });

  test("a broken code signature fails closed even when identity metadata is present", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ codesignBroken: true })],
    });
    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_invalid_signature");
    expect(result.error.failedPredicates).toContain("signature_valid");
    expect(result.selected).toBe(false);
  });

  test("rejects a self-declared team identifier without the trusted Apple signer chain", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          signingTeam: CANONICAL_SIGNING_TEAM,
          codesignRequirementMismatch: true,
        }),
      ],
    });
    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_invalid_signature");
    expect(result.error.failedPredicates).toContain("signature_valid");
  });

  test("requires the canonical executable to be executable by the current process", async () => {
    const executablePath = `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/ChatGPT`;
    const { adapters, fs } = createFixtureAdapters({});
    fs.seedFile(executablePath, "not-executable", 0o401);
    fs.setNonExecutable(executablePath);

    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_broken_executable_relationship");
    expect(result.error.failedPredicates).toContain("executable_access");
  });

  test("missing relevant host bytes fail closed with a structured predicate", async () => {
    const { adapters, fs } = createFixtureAdapters({});
    fs.entries.delete(`${CANONICAL_BUNDLE_PATH}/Contents/Resources/app.asar`);

    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_malformed");
    expect(result.error.failedPredicates).toContain(
      "host_hash_readable:Contents/Resources/app.asar",
    );
  });

  test("unreadable relevant host bytes fail closed with a structured predicate", async () => {
    const { adapters } = createFixtureAdapters({
      bundles: [
        defaultCanonicalBundleOptions({
          unreadableRelativePaths: ["Contents/Resources/app.asar"],
        }),
      ],
    });

    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("host_malformed");
    expect(result.error.failedPredicates).toContain(
      "host_hash_readable:Contents/Resources/app.asar",
    );
  });

  test("failure selects none and leaves candidates unchanged (no writes)", async () => {
    const { adapters, fs } = createFixtureAdapters({
      bundles: [defaultCanonicalBundleOptions({ signingTeam: "BADTEAM0000" })],
    });
    const beforeKeys = [...fs.entries.keys()].sort();
    const result = await inspectHost({ adapters });
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
    const result = await inspectHost({ adapters });
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
    const result = await inspectHost({ adapters });
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
    const result = await inspectHost({ adapters });
    expect(result.ok).toBe(true);
    // No CDP or process fields are required on the success path.
    expect("cdp" in result).toBe(false);
    expect(result.readOnly).toBe(true);
  });
});
