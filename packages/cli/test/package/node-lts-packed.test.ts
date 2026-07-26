import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("packed CLI under Node 22 and Node 24", () => {
  test("identical artifact yields equivalent help and JSON outcomes without Bun", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-node-lts-cli-"));
    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "pack-sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "pack-cli"));
      const { consumerRoot, cleanup } = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
      });
      try {
        const bin = join(consumerRoot, "node_modules", ".bin", "explodex");
        const node22 = miseNodeBinary(22);
        const node24 = miseNodeBinary(24);

        const outcomes: Array<{
          label: string;
          help: { status: number; stdout: string };
          version: { status: number; json: unknown };
          unknown: { status: number; json: unknown };
          host: { status: number; json: unknown };
          compat: { status: number; json: unknown };
        }> = [];

        for (const [label, nodeBin] of [
          ["Node 22", node22],
          ["Node 24", node24],
        ] as const) {
          const home = join(scratch, `home-${label.replace(" ", "-")}`);
          // Node dir is required for shebang bins; Bun must remain absent.
          const nodeDir = join(nodeBin, "..");
          const env = {
            PATH: `${nodeDir}:${SYSTEM_PATH}`,
            HOME: home,
            npm_config_cache: join(scratch, `cache-${label.replace(" ", "-")}`),
          };

          // Bun must be absent
          const bunCheck = Bun.spawnSync([nodeBin, "-e", "console.log(process.env.PATH)"], {
            env,
            stdout: "pipe",
          });
          expect(bunCheck.stdout.toString("utf8").toLowerCase().includes("bun")).toBe(false);

          const help = Bun.spawnSync([nodeBin, bin, "--help"], {
            cwd: consumerRoot,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const version = Bun.spawnSync([nodeBin, bin, "--json", "--version"], {
            cwd: consumerRoot,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const unknown = Bun.spawnSync([nodeBin, bin, "--json", "definitely-not-a-command"], {
            cwd: consumerRoot,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const host = Bun.spawnSync(
            [nodeBin, bin, "--json", "--home", home, "host", "inspect"],
            { cwd: consumerRoot, env, stdout: "pipe", stderr: "pipe" },
          );
          const compat = Bun.spawnSync(
            [nodeBin, bin, "--json", "--home", home, "compatibility", "report"],
            { cwd: consumerRoot, env, stdout: "pipe", stderr: "pipe" },
          );

          expect(help.exitCode).toBe(0);
          expect(help.stdout.toString("utf8")).toContain("/Applications/ChatGPT.app");
          expect(version.exitCode).toBe(0);
          expect(unknown.exitCode).toBe(2);
          // host/compat may succeed or fail based on host presence, but must emit schemaVersion 1
          for (const result of [version, unknown, host, compat]) {
            const stdout = result.stdout.toString("utf8");
            const parsed = JSON.parse(stdout.trim()) as {
              schemaVersion: number;
              ok: boolean;
              operation: string;
            };
            expect(parsed.schemaVersion).toBe(1);
            expect(typeof parsed.operation).toBe("string");
          }

          const unknownJson = JSON.parse(unknown.stdout.toString("utf8").trim()) as {
            operation: string;
            error: { code: string };
          };
          expect(unknownJson.error.code).toBe("usage.unknown-command");

          const hostJson = JSON.parse(host.stdout.toString("utf8").trim()) as {
            operation: string;
          };
          expect(hostJson.operation).toBe("host.report");

          const compatJson = JSON.parse(compat.stdout.toString("utf8").trim()) as {
            operation: string;
          };
          expect(compatJson.operation).toBe("compatibility.status");

          outcomes.push({
            label,
            help: { status: help.exitCode ?? 1, stdout: help.stdout.toString("utf8") },
            version: {
              status: version.exitCode ?? 1,
              json: JSON.parse(version.stdout.toString("utf8").trim()),
            },
            unknown: {
              status: unknown.exitCode ?? 1,
              json: JSON.parse(unknown.stdout.toString("utf8").trim()),
            },
            host: {
              status: host.exitCode ?? 1,
              json: JSON.parse(host.stdout.toString("utf8").trim()),
            },
            compat: {
              status: compat.exitCode ?? 1,
              json: JSON.parse(compat.stdout.toString("utf8").trim()),
            },
          });
        }

        // Equivalent outcome classification across Node 22 and 24
        expect(outcomes).toHaveLength(2);
        const [a, b] = outcomes;
        expect(a!.version.status).toBe(b!.version.status);
        expect(a!.unknown.status).toBe(b!.unknown.status);
        expect(a!.host.status).toBe(b!.host.status);
        expect(a!.compat.status).toBe(b!.compat.status);
        expect((a!.version.json as { operation: string }).operation).toBe(
          (b!.version.json as { operation: string }).operation,
        );
        expect((a!.unknown.json as { error: { code: string } }).error.code).toBe(
          (b!.unknown.json as { error: { code: string } }).error.code,
        );
        expect((a!.host.json as { operation: string }).operation).toBe(
          (b!.host.json as { operation: string }).operation,
        );
        expect((a!.compat.json as { operation: string }).operation).toBe(
          (b!.compat.json as { operation: string }).operation,
        );
      } finally {
        await cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 240_000);
});
