import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
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
        devDependencies: { "@explodex/sdk": "1.2.0", typescript: "5.9.3" },
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
  displayName: "Packed Build",
  description: "external workspace",
  lifecycle: "dynamic",
});
`,
  );
  await writeFile(
    join(workspace, "src/index.ts"),
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  setup(api) {
    api.log.info("built");
  },
});
`,
  );
  await writeFile(join(workspace, "README.md"), "# Packed Build\n");
  await writeFile(
    join(workspace, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noImplicitAny: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
        },
        include: ["src/**/*.ts", "explodex.config.ts"],
      },
      null,
      2,
    )}\n`,
  );

  // Link SDK for config resolution.
  const sdkTarget = join(workspace, "node_modules", "@explodex", "sdk");
  await mkdir(dirname(sdkTarget), { recursive: true });
  await mkdir(sdkTarget, { recursive: true });
  await cp(join(SDK_PACKAGE_ROOT, "package.json"), join(sdkTarget, "package.json"));
  await cp(join(SDK_PACKAGE_ROOT, "dist"), join(sdkTarget, "dist"), { recursive: true });
  return workspace;
}

describe("VAL-SDK-016 packed plugin build under Node 22 and 24", () => {
  test("identical packed CLI builds classic IIFE without Bun", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-node-lts-build-"));
    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "pack-sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "pack-cli"));
      const { consumerRoot, cleanup } = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
      });
      try {
        const bin = join(consumerRoot, "node_modules", ".bin", "explodex");
        // esbuild must resolve from the packed CLI dependency tree.
        const esbuildPkg = join(consumerRoot, "node_modules", "esbuild", "package.json");
        const esbuildPresent = await readFile(esbuildPkg, "utf8").then(
          () => true,
          () => false,
        );
        expect(esbuildPresent).toBe(true);

        const outcomes: Array<{
          label: string;
          ok: boolean;
          operation: string;
          entry?: string;
        }> = [];

        for (const [label, major] of [
          ["Node 22", 22],
          ["Node 24", 24],
        ] as const) {
          const nodeBin = miseNodeBinary(major);
          const workspace = await writeExternalWorkspace(
            scratch,
            `explodex-plugin-packed-build-${major}`,
          );
          const monorepoTsc = join(CLI_PACKAGE_ROOT, "..", "..", "node_modules", ".bin", "tsc");
          const proc = Bun.spawn(
            [nodeBin, bin, "--json", "plugin", "build", workspace],
            {
              cwd: workspace,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env: {
                // Node-only PATH: no Bun/repository bins.
                PATH: `${dirname(nodeBin)}:${SYSTEM_PATH}`,
                HOME: join(scratch, `home-${major}`),
                TMPDIR: scratch,
                // Typecheck uses the monorepo TypeScript binary via explicit env.
                EXPLODEX_TSC: monorepoTsc,
              },
            },
          );
          const status = await proc.exited;
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const parsed = JSON.parse(stdout.trim()) as {
            ok: boolean;
            operation: string;
            result?: { entry?: string; jsBytes?: number };
            error?: { code: string; message: string };
          };
          if (!parsed.ok) {
            throw new Error(
              `${label} build failed: ${parsed.error?.message ?? stdout}\nstderr=${stderr}`,
            );
          }
          expect(status).toBe(0);
          expect(parsed.operation).toBe("plugin.build");
          expect(parsed.result?.entry).toBe("index.js");
          const index = await readFile(join(workspace, "dist", "index.js"), "utf8");
          expect(/^\s*import\s/m.test(index)).toBe(false);
          expect(index.includes("require(")).toBe(false);
          expect(index.includes("__EXPLODEX_PRIVATE_REGISTER__")).toBe(true);
          outcomes.push({
            label,
            ok: parsed.ok,
            operation: parsed.operation,
            entry: parsed.result?.entry,
          });
        }

        expect(outcomes).toHaveLength(2);
        expect(outcomes[0]?.ok).toBe(outcomes[1]?.ok);
        expect(outcomes[0]?.entry).toBe(outcomes[1]?.entry);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
