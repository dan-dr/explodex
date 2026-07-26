import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import {
  CANONICAL_BUNDLE_ID,
  CANONICAL_BUNDLE_PATH,
  CANONICAL_EXECUTABLE_NAME,
  CANONICAL_SIGNING_TEAM,
  MISSION_BASELINE_APP_BUILD,
  MISSION_BASELINE_APP_VERSION,
} from "../../src/host/constants.ts";
import { createDefaultHostAdapters } from "../../src/host/adapters.ts";
import { inspectCanonicalHost } from "../../src/host/identity.ts";
import { reportHost } from "../../src/host/report.ts";
import { sha256Of } from "./fixture-fs.ts";

async function chatgptInstalled(): Promise<boolean> {
  try {
    await access(CANONICAL_BUNDLE_PATH);
    return true;
  } catch {
    return false;
  }
}

describe("installed ChatGPT.app read-only inspection", () => {
  // Full Info.plist + executable + app.asar hashing is mandatory and can exceed
  // the default bun test timeout on large installed hosts.
  test(
    "resolves mission baseline host identity without writes or CDP",
    async () => {
      if (!(await chatgptInstalled())) {
        // Controlled environments without the host still run fixture tests.
        expect(true).toBe(true);
        return;
      }

      const adapters = await createDefaultHostAdapters();
      const result = await inspectCanonicalHost(adapters);

      expect(result.ok).toBe(true);
      if (!result.ok || !result.host) throw new Error("expected installed host");
      expect(result.host.bundlePath).toBe(CANONICAL_BUNDLE_PATH);
      expect(result.host.bundleId).toBe(CANONICAL_BUNDLE_ID);
      expect(result.host.executableName).toBe(CANONICAL_EXECUTABLE_NAME);
      expect(result.host.executablePath).toBe(
        `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/${CANONICAL_EXECUTABLE_NAME}`,
      );
      expect(result.host.signingTeam).toBe(CANONICAL_SIGNING_TEAM);
      // Mission baseline constants stay fixed; a later host update remains a valid
      // host (VAL-HOST-003) and must not silently rewrite the mission baseline.
      expect(result.host.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.host.appBuild).toMatch(/^\d+$/);
      if (result.host.appBuild === MISSION_BASELINE_APP_BUILD) {
        expect(result.host.appVersion).toBe(MISSION_BASELINE_APP_VERSION);
      } else {
        expect(result.host.appVersion).not.toBe(MISSION_BASELINE_APP_VERSION);
        expect(result.host.appBuild).not.toBe(MISSION_BASELINE_APP_BUILD);
      }
      expect(result.host.hostHashes["Contents/Info.plist"]).toMatch(/^[a-f0-9]{64}$/);
      expect(result.host.hostHashes["Contents/MacOS/ChatGPT"]).toMatch(/^[a-f0-9]{64}$/);
      expect(result.host.hostHashes["Contents/Resources/app.asar"]).toMatch(/^[a-f0-9]{64}$/);
      expect(result.readOnly).toBe(true);
      expect(result.compatibility.allowsCompatibilityDependentWork).toBe(false);

      const home = `/tmp/explodex-homes/installed-report-${process.pid}/.explodex`;
      const report = await reportHost({
        adapters,
        explodexHome: home,
        sdkRuntime: {
          version: "0.0.0-migration",
          sha256: sha256Of("placeholder-sdk-runtime"),
        },
      });
      expect(report.ok).toBe(true);
      expect(report.compatibility.status).toBe("unproven");
      expect(report.compatibility.nextAction).toContain("9444");
    },
    { timeout: 120_000 },
  );
});
