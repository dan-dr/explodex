import { describe, expect, test } from "bun:test";
import {
  auditTarballEntries,
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
        const audit = await auditTarballEntries(tarballPath);
        const paths = audit.entries.map((entry) => entry.path);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          for (const id of FIRST_PARTY_PLUGIN_IDS) {
            expect(path.includes(id)).toBe(false);
          }
          expect(path.includes("plugin-registry")).toBe(false);
          expect(path.includes("plugins/")).toBe(false);
        }

        // Scan every regular entry's exact extracted bytes, not the compressed
        // container representation where payload strings may be invisible.
        for (const entry of audit.entries) {
          if (entry.type !== "file") continue;
          const text = entry.bytes.toString("utf8");
          for (const id of FIRST_PARTY_PLUGIN_IDS) {
            expect(text.includes(id)).toBe(false);
          }
          for (const sentinel of PAYLOAD_SENTINELS) {
            if (sentinel === "explodex-plugin-") continue;
            if (text.includes(sentinel)) {
              throw new Error(
                `Packed payload sentinel ${JSON.stringify(sentinel)} found in ${entry.path}`,
              );
            }
          }
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

  test("tarball audit rejects escaping links, special entries, and path escape", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "explodex-hostile-package-tar-"));
    try {
      for (const fixture of [
        { type: "2", path: "package/link", linkPath: "../../outside" },
        { type: "1", path: "package/hard", linkPath: "package/other" },
        { type: "3", path: "package/device" },
        { type: "6", path: "package/fifo" },
        { type: "0", path: "package/../escape", contents: "escape" },
        { type: "0", path: " package/escape", contents: "escape" },
        { type: "0", path: "package /escape", contents: "escape" },
      ]) {
        const path = join(scratch, `fixture-${fixture.type}-${Math.random()}.tgz`);
        await Bun.write(path, makeTarGzip(fixture));
        await expect(auditTarballEntries(path)).rejects.toThrow();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

function makeTarGzip(options: {
  type: string;
  path: string;
  linkPath?: string;
  contents?: string;
}): Uint8Array {
  const data = Buffer.from(options.contents ?? "");
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, options.path);
  writeTarText(header, 100, 8, "0000600");
  writeTarText(header, 108, 8, "0000000");
  writeTarText(header, 116, 8, "0000000");
  writeTarText(header, 124, 12, data.byteLength.toString(8).padStart(11, "0"));
  writeTarText(header, 136, 12, "00000000000");
  header.fill(0x20, 148, 156);
  header[156] = options.type.charCodeAt(0);
  if (options.linkPath !== undefined) {
    writeTarText(header, 157, 100, options.linkPath);
  }
  writeTarText(header, 257, 6, "ustar");
  writeTarText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarText(header, 148, 8, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (data.byteLength % 512)) % 512);
  const tar = Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
  return Bun.gzipSync(tar);
}

function writeTarText(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(target, offset, 0, Math.min(bytes.byteLength, length));
}
