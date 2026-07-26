import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_PACKAGE_ROOT,
  SDK_PACKAGE_ROOT,
  SYSTEM_PATH,
  buildPackage,
  installSdkAndCli,
  miseNodeBinary,
  packActual,
} from "./helpers.ts";

describe("inert package installation", () => {
  test("scripts-disabled install creates no Explodex state or host side effects", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-inert-"));
    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "pack-sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "pack-cli"));
      const isolatedHome = join(scratch, "home");
      await mkdirp(isolatedHome);

      const before = await snapshotHome(isolatedHome);
      const { consumerRoot, cleanup } = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
      });
      try {
        const after = await snapshotHome(isolatedHome);
        expect(after).toEqual(before);

        // No default .explodex under isolated home
        await expectMissing(join(isolatedHome, ".explodex"));

        // Packages installed under consumer node_modules only
        await access(join(consumerRoot, "node_modules", "explodex", "package.json"));
        await access(join(consumerRoot, "node_modules", "@explodex", "sdk", "package.json"));

        // Bin exists but was not executed during install
        const bin = join(consumerRoot, "node_modules", ".bin", "explodex");
        await access(bin);

        // Prove help works from install without creating home state.
        // Keep Bun out of PATH, but include a real Node directory for shebang resolution.
        const nodeDir = join(miseNodeBinary(22), "..");
        const result = Bun.spawnSync(
          [bin, "--help"],
          {
            cwd: consumerRoot,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PATH: `${nodeDir}:${SYSTEM_PATH}`,
              HOME: isolatedHome,
              npm_config_cache: join(scratch, "npm-cache"),
            },
          },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `help failed (${result.exitCode}): ${result.stderr.toString("utf8")}\n${result.stdout.toString("utf8")}`,
          );
        }
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString("utf8").toLowerCase().includes("bun")).toBe(false);
        const afterHelp = await snapshotHome(isolatedHome);
        expect(afterHelp).toEqual(before);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});

async function mkdirp(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}

async function snapshotHome(home: string): Promise<string[]> {
  try {
    const entries = await readdir(home, { withFileTypes: true });
    const names = entries.map((entry) => `${entry.isDirectory() ? "d" : "f"}:${entry.name}`).sort();
    return names;
  } catch {
    return [];
  }
}

async function expectMissing(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`Expected missing path: ${path}`);
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code !== "ENOENT") throw error;
  }
}
