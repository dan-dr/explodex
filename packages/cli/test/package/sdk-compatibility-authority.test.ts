import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  buildPackage,
  CLI_PACKAGE_ROOT,
  installSdkAndCli,
  packActual,
  SDK_PACKAGE_ROOT,
} from "./helpers.ts";
import { withTempDir } from "../../../sdk/test/helpers/pack.ts";

/**
 * Shared range fixtures used by both the packed SDK and the CLI re-export.
 * Proves one interpretation, not two.
 */
const SHARED_RANGE_FIXTURES: Array<{
  version: unknown;
  range: unknown;
  expected: boolean;
  label: string;
}> = [
  { version: "1.2.0", range: "^1.2.0", expected: true, label: "caret inclusive" },
  { version: "2.0.0", range: "^1.2.0", expected: false, label: "caret exclusive major" },
  { version: "1.2.0", range: ">=1.2.0 <1.3.0", expected: true, label: "AND bounds" },
  { version: "1.3.0", range: ">=1.2.0 <1.3.0", expected: false, label: "AND upper exclusive" },
  { version: "1.2.0-rc.1", range: "^1.2.0", expected: false, label: "prerelease denied" },
  {
    version: "1.2.0-rc.1",
    range: ">=1.2.0-rc.1",
    expected: true,
    label: "prerelease admitted",
  },
  { version: "1.2.0+meta", range: "1.2.0", expected: true, label: "build metadata ignored" },
  { version: undefined, range: "^1.0.0", expected: false, label: "missing version" },
  { version: "1.2.0", range: undefined, expected: false, label: "missing range" },
  { version: "1.2", range: "^1.0.0", expected: false, label: "malformed version" },
  { version: "1.2.0", range: "not-a-range", expected: false, label: "malformed range" },
  { version: "1.5.0", range: "^1.0.0 || ^2.0.0", expected: true, label: "union left" },
  { version: "2.1.0", range: "^1.0.0 || ^2.0.0", expected: true, label: "union right" },
  { version: "3.0.0", range: "^1.0.0 || ^2.0.0", expected: false, label: "union miss" },
];

describe("VAL-SDK-008 CLI uses the packed SDK compatibility authority", () => {
  test("CLI re-export resolves to the same packed helper identity and shared fixture outcomes", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);

    await withTempDir("explodex-cli-sdk-compat-", async (dir) => {
      const sdkPack = await packActual(SDK_PACKAGE_ROOT, dir);
      const cliPack = await packActual(CLI_PACKAGE_ROOT, dir);
      const installed = await installSdkAndCli({
        sdkTarball: sdkPack.tarballPath,
        cliTarball: cliPack.tarballPath,
      });
      try {
        const sdkIndex = join(
          installed.consumerRoot,
          "node_modules",
          "@explodex",
          "sdk",
          "dist",
          "index.js",
        );
        const sdkCompat = join(
          installed.consumerRoot,
          "node_modules",
          "@explodex",
          "sdk",
          "dist",
          "compatibility.js",
        );
        const cliCompat = join(
          installed.consumerRoot,
          "node_modules",
          "explodex",
          "dist",
          "sdk",
          "compatibility.js",
        );

        const sdkMod = (await import(pathToFileURL(sdkIndex).href)) as {
          SDK_VERSION: string;
          satisfiesSdkRange: (version: unknown, range: unknown) => boolean;
          evaluateSdkCompatibility: (
            version: unknown,
            range: unknown,
          ) => { ok: boolean; reason?: string };
          parseSemVer: (value: unknown) => unknown;
        };

        // CLI module must import from @explodex/sdk, not embed a second implementation.
        const cliSource = await readFile(cliCompat, "utf8");
        expect(cliSource.includes("@explodex/sdk")).toBe(true);
        expect(cliSource.includes("function parseSemVer")).toBe(false);
        expect(cliSource.includes("function satisfiesSdkRange")).toBe(false);

        const cliMod = (await import(pathToFileURL(cliCompat).href)) as {
          SDK_VERSION: string;
          satisfiesSdkRange: (version: unknown, range: unknown) => boolean;
          evaluateSdkCompatibility: (
            version: unknown,
            range: unknown,
          ) => { ok: boolean; reason?: string };
          parseSemVer: (value: unknown) => unknown;
        };

        expect(cliMod.SDK_VERSION).toBe(sdkMod.SDK_VERSION);
        expect(typeof cliMod.satisfiesSdkRange).toBe("function");
        expect(typeof cliMod.evaluateSdkCompatibility).toBe("function");
        expect(cliMod.satisfiesSdkRange).toBe(sdkMod.satisfiesSdkRange);
        expect(cliMod.evaluateSdkCompatibility).toBe(sdkMod.evaluateSdkCompatibility);
        expect(cliMod.parseSemVer).toBe(sdkMod.parseSemVer);

        // Shared fixture matrix: identical boolean outcomes from both entry points.
        for (const fixture of SHARED_RANGE_FIXTURES) {
          const fromSdk = sdkMod.satisfiesSdkRange(fixture.version, fixture.range);
          const fromCli = cliMod.satisfiesSdkRange(fixture.version, fixture.range);
          expect(fromSdk).toBe(fixture.expected);
          expect(fromCli).toBe(fixture.expected);
          expect(fromCli).toBe(fromSdk);
        }

        // Source bytes of the authoritative implementation are only in the SDK package.
        const sdkCompatBytes = await readFile(sdkCompat);
        const sdkDigest = createHash("sha256").update(sdkCompatBytes).digest("hex");
        expect(sdkDigest.length).toBe(64);
        expect(cliSource.length).toBeLessThan(sdkCompatBytes.byteLength);
      } finally {
        await installed.cleanup();
      }
    });
  }, 180_000);
});
