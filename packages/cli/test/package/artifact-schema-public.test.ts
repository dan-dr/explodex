import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  packActual,
} from "./helpers.ts";
import { ARTIFACT_SCHEMA_V1_LIMITS as PUBLIC_LIMITS } from "../../src/artifact-schema.ts";
import { ARTIFACT_SCHEMA_V1_LIMITS as INTERNAL_LIMITS } from "../../src/plugin/artifact-schema.ts";

const EXPECTED_LIMITS = INTERNAL_LIMITS;

describe("packed public artifact-schema contract", () => {
  test("exports the immutable V1 limits with declarations under Node 22 and 24", async () => {
    expect(PUBLIC_LIMITS).toBe(INTERNAL_LIMITS);
    expect(Object.isFrozen(PUBLIC_LIMITS)).toBe(true);

    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-artifact-schema-public-"));

    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "pack-sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "pack-cli"));
      const packedPaths = new Set(cli.listing.files.map((entry) => entry.path));
      expect(packedPaths.has("dist/artifact-schema.js")).toBe(true);
      expect(packedPaths.has("dist/artifact-schema.d.ts")).toBe(true);
      expect(packedPaths.has("README.md")).toBe(true);

      const { consumerRoot, cleanup } = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
      });
      try {
        const installedPackageRoot = await realpath(
          join(consumerRoot, "node_modules", "explodex"),
        );
        const packageJson = JSON.parse(
          await readFile(join(installedPackageRoot, "package.json"), "utf8"),
        ) as {
          exports?: Record<string, unknown>;
        };
        expect(packageJson.exports?.["./artifact-schema"]).toEqual({
          types: "./dist/artifact-schema.d.ts",
          import: "./dist/artifact-schema.js",
        });
        expect(packageJson.exports?.["./plugin/*"]).toBeUndefined();

        const runtimeProbe = join(consumerRoot, "artifact-schema-runtime.mjs");
        const typeProbe = join(consumerRoot, "artifact-schema-types.ts");
        const tsconfig = join(consumerRoot, "tsconfig.json");

        await writeFile(
          runtimeProbe,
          `
            const expected = ${JSON.stringify(EXPECTED_LIMITS)};
            const resolved = import.meta.resolve("explodex/artifact-schema");
            const artifactSchema = await import("explodex/artifact-schema");
            if (JSON.stringify(artifactSchema.ARTIFACT_SCHEMA_V1_LIMITS) !== JSON.stringify(expected)) {
              throw new Error("public limits differ from the V1 authority");
            }
            if (!Object.isFrozen(artifactSchema.ARTIFACT_SCHEMA_V1_LIMITS)) {
              throw new Error("public limits object is mutable");
            }
            try {
              await import("explodex/plugin/artifact-schema");
              throw new Error("private plugin path unexpectedly resolved");
            } catch (error) {
              if (error instanceof Error && error.message === "private plugin path unexpectedly resolved") {
                throw error;
              }
            }
            process.stdout.write(JSON.stringify({ resolved, limits: artifactSchema.ARTIFACT_SCHEMA_V1_LIMITS }));
          `,
          "utf8",
        );
        await writeFile(
          typeProbe,
          `
            import { ARTIFACT_SCHEMA_V1_LIMITS } from "explodex/artifact-schema";

            const schemaVersion: 1 = ARTIFACT_SCHEMA_V1_LIMITS.schemaVersion;
            const archiveEntries: number = ARTIFACT_SCHEMA_V1_LIMITS.maxArchiveEntries;
            const pathBytes: number = ARTIFACT_SCHEMA_V1_LIMITS.maxNormalizedPathBytes;
            const fileBytes: number = ARTIFACT_SCHEMA_V1_LIMITS.maxFileUncompressedBytes;
            const totalBytes: number = ARTIFACT_SCHEMA_V1_LIMITS.maxTotalUncompressedBytes;
            const ratio: number = ARTIFACT_SCHEMA_V1_LIMITS.maxCompressionRatio;

            void [schemaVersion, archiveEntries, pathBytes, fileBytes, totalBytes, ratio];
          `,
          "utf8",
        );
        await writeFile(
          tsconfig,
          `${JSON.stringify(
            {
              compilerOptions: {
                strict: true,
                noEmit: true,
                target: "ES2023",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                skipLibCheck: false,
              },
              files: ["artifact-schema-types.ts"],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        for (const major of [22, 24] as const) {
          const nodeBin = miseNodeBinary(major);
          const env = {
            PATH: `${join(nodeBin, "..")}:${SYSTEM_PATH}`,
            HOME: join(consumerRoot, `home-node-${major}`),
            npm_config_cache: join(consumerRoot, `.npm-cache-node-${major}`),
          };
          const runtime = Bun.spawnSync([nodeBin, runtimeProbe], {
            cwd: consumerRoot,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(runtime.exitCode).toBe(0);
          const result = JSON.parse(runtime.stdout.toString("utf8")) as {
            resolved: string;
            limits: typeof EXPECTED_LIMITS;
          };
          expect(result.limits).toEqual(EXPECTED_LIMITS);
          expect(result.resolved).toBe(
            `file://${join(installedPackageRoot, "dist", "artifact-schema.js")}`,
          );
          expect(result.resolved.includes(REPO_ROOT)).toBe(false);
          expect(runtime.stderr.toString("utf8")).toBe("");

          const typecheck = Bun.spawnSync(
            [
              nodeBin,
              join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
              "--project",
              tsconfig,
            ],
            {
              cwd: consumerRoot,
              env,
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          expect(typecheck.exitCode).toBe(0);
          expect(typecheck.stdout.toString("utf8")).toBe("");
          expect(typecheck.stderr.toString("utf8")).toBe("");
        }
      } finally {
        await cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 240_000);
});
