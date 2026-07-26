import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLI_PACKAGE_ROOT,
  SDK_PACKAGE_ROOT,
  SYSTEM_PATH,
  buildPackage,
  installSdkAndCli,
  miseNodeBinary,
  packActual,
} from "./helpers.ts";

async function writeExternalWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, name);
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await mkdir(join(workspace, "assets"), { recursive: true });
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        peerDependencies: { "@explodex/sdk": "^1.2.0" },
        devDependencies: { "@explodex/sdk": "1.2.0" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(workspace, "explodex.config.ts"),
    `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: "0.1.0",
  displayName: "Packed Validate",
  description: "external workspace",
  lifecycle: "dynamic",
});
`,
  );
  await writeFile(
    join(workspace, "src/index.ts"),
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({ setup() {} });
`,
  );
  await writeFile(join(workspace, "README.md"), "# Packed Validate\n");
  await writeFile(
    join(workspace, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }, null, 2)}\n`,
  );
  // Link SDK for config resolution from the workspace itself.
  const sdkTarget = join(workspace, "node_modules", "@explodex", "sdk");
  await mkdir(dirname(sdkTarget), { recursive: true });
  await mkdir(sdkTarget, { recursive: true });
  await cp(join(SDK_PACKAGE_ROOT, "package.json"), join(sdkTarget, "package.json"));
  await cp(join(SDK_PACKAGE_ROOT, "dist"), join(sdkTarget, "dist"), { recursive: true });
  return workspace;
}

describe("VAL-HOST-041 packed plugin validate under Node 22 and 24", () => {
  test("identical packed CLI classifies valid and invalid workspaces equivalently without Bun", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-node-lts-validate-"));
    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "pack-sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "pack-cli"));
      const { consumerRoot, cleanup } = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
      });
      try {
        const bin = join(consumerRoot, "node_modules", ".bin", "explodex");
        const validWorkspace = await writeExternalWorkspace(
          scratch,
          "explodex-plugin-packed-ok",
        );
        const invalidWorkspace = await writeExternalWorkspace(
          scratch,
          "explodex-plugin-packed-bad",
        );
        await rm(join(invalidWorkspace, "explodex.config.ts"));

        const outcomes: Array<{
          label: string;
          valid: { status: number | null; ok: boolean; operation: string; id?: string };
          invalid: { status: number | null; ok: boolean; operation: string; code?: string };
        }> = [];

        for (const [label, major] of [
          ["Node 22", 22],
          ["Node 24", 24],
        ] as const) {
          const nodeBin = miseNodeBinary(major);
          const nodeDir = join(nodeBin, "..");
          const home = join(scratch, `home-${major}`);
          const env = {
            PATH: `${nodeDir}:${SYSTEM_PATH}`,
            HOME: home,
            npm_config_cache: join(scratch, `cache-${major}`),
          };

          // Bun must be absent from PATH.
          expect(env.PATH.toLowerCase().includes("bun")).toBe(false);

          const validRun = Bun.spawnSync(
            [nodeBin, bin, "--json", "plugin", "validate", validWorkspace],
            { cwd: consumerRoot, env, stdout: "pipe", stderr: "pipe" },
          );
          const invalidRun = Bun.spawnSync(
            [nodeBin, bin, "--json", "plugin", "validate", invalidWorkspace],
            { cwd: consumerRoot, env, stdout: "pipe", stderr: "pipe" },
          );

          const validJson = JSON.parse(validRun.stdout.toString("utf8").trim()) as {
            schemaVersion: number;
            ok: boolean;
            operation: string;
            result?: { id: string };
            error?: { code: string };
          };
          const invalidJson = JSON.parse(invalidRun.stdout.toString("utf8").trim()) as {
            schemaVersion: number;
            ok: boolean;
            operation: string;
            error?: { code: string };
          };

          expect(validJson.schemaVersion).toBe(1);
          expect(invalidJson.schemaVersion).toBe(1);
          expect(validJson.operation).toBe("plugin.validate");
          expect(invalidJson.operation).toBe("plugin.validate");
          expect(validJson.ok).toBe(true);
          expect(invalidJson.ok).toBe(false);
          expect(validRun.exitCode).toBe(0);
          expect(invalidRun.exitCode).not.toBe(0);
          expect(validJson.result?.id).toBe("packed-ok");
          expect(invalidJson.error?.code).toBe("plugin.source.invalid");

          outcomes.push({
            label,
            valid: {
              status: validRun.exitCode,
              ok: validJson.ok,
              operation: validJson.operation,
              id: validJson.result?.id,
            },
            invalid: {
              status: invalidRun.exitCode,
              ok: invalidJson.ok,
              operation: invalidJson.operation,
              code: invalidJson.error?.code,
            },
          });
        }

        expect(outcomes).toHaveLength(2);
        expect(outcomes[0]!.valid).toEqual(outcomes[1]!.valid);
        expect(outcomes[0]!.invalid.ok).toBe(outcomes[1]!.invalid.ok);
        expect(outcomes[0]!.invalid.code).toBe(outcomes[1]!.invalid.code);
        expect(outcomes[0]!.invalid.operation).toBe(outcomes[1]!.invalid.operation);
        // Exit classifications should match across Node versions.
        expect(outcomes[0]!.invalid.status).toBe(outcomes[1]!.invalid.status);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
