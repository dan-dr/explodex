import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_PACKAGE_ROOT,
  REPO_ROOT,
  SDK_PACKAGE_ROOT,
  SYSTEM_PATH,
  buildPackage,
  installSdkAndCli,
  miseNodeBinary,
  packRuntimeDependencyClosure,
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
      const dependencyTarballs = await packRuntimeDependencyClosure(
        join(scratch, "pack-dependencies"),
      );
      const { consumerRoot, cleanup } = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
        dependencyTarballs,
        offline: true,
      });
      try {
        const bin = join(consumerRoot, "node_modules", ".bin", "explodex");
        const installedBin = await realpath(bin);
        const installedPackageRoot = await realpath(join(
          consumerRoot,
          "node_modules",
          "explodex",
        ));
        expect(installedBin.startsWith(installedPackageRoot)).toBe(true);
        const cliTarballSha256 = createHash("sha256")
          .update(await readFile(cli.tarballPath))
          .digest("hex");
        const sdkTarballSha256 = createHash("sha256")
          .update(await readFile(sdk.tarballPath))
          .digest("hex");
        const node22 = miseNodeBinary(22);
        const node24 = miseNodeBinary(24);

        const outcomes: Array<{
          label: string;
          tarballs: { cliSha256: string; sdkSha256: string };
          matrix: Record<string, { status: number; stdout: string; stderr: string }>;
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

          const commands = {
            rootHelp: ["--help"],
            helpSubcommand: ["help"],
            groupHelp: ["help", "plugin"],
            hostHelp: ["host", "report", "--help"],
            compatibilityHelp: ["help", "compatibility", "status"],
            hostCanonical: ["--json", "--home", home, "host", "report"],
            hostAlias: ["--json", "--home", home, "host", "inspect"],
            compatibilityCanonical: [
              "--json",
              "--home",
              home,
              "compatibility",
              "status",
            ],
            compatibilityAlias: [
              "--json",
              "--home",
              home,
              "compatibility",
              "report",
            ],
            pluginStatusSuccess: [
              "--json",
              "--home",
              home,
              "plugin",
              "status",
            ],
            usageFailure: ["--json", "definitely-not-a-command"],
          } as const;
          const matrix: Record<
            string,
            { status: number; stdout: string; stderr: string }
          > = {};
          for (const [name, args] of Object.entries(commands)) {
            const result = Bun.spawnSync([nodeBin, bin, ...args], {
              cwd: consumerRoot,
              env,
              stdout: "pipe",
              stderr: "pipe",
            });
            matrix[name] = {
              status: result.exitCode ?? 1,
              stdout: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            };
          }

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

          for (const name of [
            "rootHelp",
            "helpSubcommand",
            "groupHelp",
            "hostHelp",
            "compatibilityHelp",
          ]) {
            expect(matrix[name]!.status).toBe(0);
            expect(matrix[name]!.stdout.length).toBeGreaterThan(0);
          }
          expect(matrix.rootHelp!.stdout).toContain("/Applications/ChatGPT.app");
          expect(matrix.hostHelp!.stdout).toContain("host report");
          expect(matrix.compatibilityHelp!.stdout).toContain("compatibility status");
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
          for (const [name, operation] of [
            ["hostCanonical", "host.report"],
            ["hostAlias", "host.report"],
            ["compatibilityCanonical", "compatibility.status"],
            ["compatibilityAlias", "compatibility.status"],
            ["pluginStatusSuccess", "plugin.status"],
          ] as const) {
            const value = JSON.parse(matrix[name]!.stdout.trim()) as {
              schemaVersion: number;
              ok: boolean;
              operation: string;
            };
            expect(value.schemaVersion).toBe(1);
            expect(value.operation).toBe(operation);
          }
          expect(matrix.pluginStatusSuccess!.status).toBe(0);
          expect(matrix.usageFailure!.status).toBe(2);
          const usage = JSON.parse(matrix.usageFailure!.stdout.trim()) as {
            error: { code: string };
          };
          expect(usage.error.code).toBe("usage.unknown-command");

          const sdkImport = Bun.spawnSync([
            nodeBin,
            "--input-type=module",
            "-e",
            `
              const sdk = await import("@explodex/sdk");
              const { resolveSdkRuntimeIdentityForCli } = await import(
                "explodex/host/sdk-runtime-identity"
              );
              const required = [
                "SDK_VERSION",
                "defineConfig",
                "definePlugin",
                "evaluateSdkCompatibility",
                "satisfiesSdkRange",
              ];
              for (const key of required) {
                if (!(key in sdk)) throw new Error("missing SDK export " + key);
              }
              const runtime = await resolveSdkRuntimeIdentityForCli();
              const packageRoot = ${JSON.stringify(installedPackageRoot)};
              if (!runtime.sourcePath.startsWith(packageRoot.replace(
                /\\/explodex$/,
                "/@explodex/sdk",
              ))) {
                throw new Error("SDK runtime escaped installed tarballs: " + runtime.sourcePath);
              }
              if (runtime.sourcePath.includes(${JSON.stringify(REPO_ROOT)})) {
                throw new Error("SDK runtime used repository fallback");
              }
            `,
          ], {
            cwd: consumerRoot,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(sdkImport.exitCode).toBe(0);

          outcomes.push({
            label,
            tarballs: {
              cliSha256: cliTarballSha256,
              sdkSha256: sdkTarballSha256,
            },
            matrix,
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
        expect(a!.tarballs).toEqual(b!.tarballs);
        for (const name of Object.keys(a!.matrix)) {
          expect(a!.matrix[name]!.status).toBe(b!.matrix[name]!.status);
          if (
            name.endsWith("Help") ||
            name === "rootHelp" ||
            name === "helpSubcommand" ||
            name === "groupHelp"
          ) {
            expect(a!.matrix[name]!.stdout).toBe(b!.matrix[name]!.stdout);
          } else {
            const left = JSON.parse(a!.matrix[name]!.stdout.trim()) as {
              schemaVersion: number;
              ok: boolean;
              operation: string;
              error?: { code?: string };
            };
            const right = JSON.parse(b!.matrix[name]!.stdout.trim()) as {
              schemaVersion: number;
              ok: boolean;
              operation: string;
              error?: { code?: string };
            };
            expect({
              schemaVersion: left.schemaVersion,
              ok: left.ok,
              operation: left.operation,
              errorCode: left.error?.code,
            }).toEqual({
              schemaVersion: right.schemaVersion,
              ok: right.ok,
              operation: right.operation,
              errorCode: right.error?.code,
            });
          }
        }
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
