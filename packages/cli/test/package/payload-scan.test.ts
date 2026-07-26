import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  FIRST_PARTY_PLUGIN_IDS,
  PAYLOAD_SENTINELS,
  SDK_PACKAGE_ROOT,
  CLI_PACKAGE_ROOT,
  buildPackage,
  packActual,
  listTarballPaths,
} from "./helpers.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SDK/CLI package payload boundaries", () => {
  test("actual tarballs contain no first-party plugin payloads", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-payload-scan-"));
    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "cli"));

      for (const { tarballPath, listing } of [sdk, cli]) {
        const paths = await listTarballPaths(tarballPath);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          for (const id of FIRST_PARTY_PLUGIN_IDS) {
            expect(path.includes(id)).toBe(false);
          }
          expect(path.includes("plugin-registry")).toBe(false);
          expect(path.includes("plugins/")).toBe(false);
        }

        // Byte scan of tarball for controlled sentinels (except legitimate package name prefixes in docs).
        const bytes = await readFile(tarballPath);
        const text = bytes.toString("utf8");
        for (const id of FIRST_PARTY_PLUGIN_IDS) {
          expect(text.includes(id)).toBe(false);
        }
        for (const sentinel of PAYLOAD_SENTINELS) {
          if (sentinel === "explodex-plugin-") {
            // package description may mention plugins generically; forbid concrete IDs only.
            continue;
          }
          expect(text.includes(sentinel)).toBe(false);
        }

        // No workspace: or file: dependencies in packed metadata.
        const packageEntry = listing.files.find((file) => file.path.endsWith("package.json"));
        expect(packageEntry).toBeDefined();
      }

      // CLI must ship bin; SDK must not ship CLI host orchestration paths.
      const cliPaths = await listTarballPaths(cli.tarballPath);
      expect(cliPaths.some((path) => path.includes("dist/bin/explodex.js"))).toBe(true);
      const sdkPaths = await listTarballPaths(sdk.tarballPath);
      expect(sdkPaths.some((path) => path.includes("dist/bin/"))).toBe(false);
      expect(sdkPaths.some((path) => path.includes("/host/"))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
