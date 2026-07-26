import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSdkPackage,
  installSdkFromTarball,
  packSdkActual,
  withTempDir,
} from "../helpers/pack.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");

async function writeFixture(root: string, relativePath: string, content: string): Promise<void> {
  const full = join(root, relativePath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("VAL-SDK-002 strict shipped declarations", () => {
  test("external strict consumer compiles and declarations contain no any", async () => {
    await buildSdkPackage();

    await withTempDir("explodex-sdk-types-", async (packDir) => {
      const { tarballPath } = await packSdkActual(packDir);
      const installed = await installSdkFromTarball(tarballPath);
      try {
        const fixtureRoot = await mkdtemp(join(tmpdir(), "explodex-sdk-tsc-"));
        try {
          await writeFixture(
            fixtureRoot,
            "package.json",
            `${JSON.stringify(
              {
                name: "explodex-sdk-type-fixture",
                private: true,
                type: "module",
              },
              null,
              2,
            )}\n`,
          );
          await writeFixture(
            fixtureRoot,
            "tsconfig.json",
            `${JSON.stringify(
              {
                compilerOptions: {
                  target: "ES2023",
                  module: "nodenext",
                  moduleResolution: "nodenext",
                  strict: true,
                  noImplicitAny: true,
                  noEmit: true,
                  skipLibCheck: false,
                  types: [],
                  paths: {
                    "@explodex/sdk": [
                      `${installed.consumerRoot}/node_modules/@explodex/sdk/dist/index.d.ts`,
                    ],
                    "@explodex/sdk/*": [
                      `${installed.consumerRoot}/node_modules/@explodex/sdk/dist/*`,
                    ],
                  },
                  baseUrl: ".",
                },
                include: ["src/**/*.ts"],
              },
              null,
              2,
            )}\n`,
          );

          // Point node_modules at the installed package for real resolution.
          await mkdir(join(fixtureRoot, "node_modules", "@explodex"), { recursive: true });
          const { symlink } = await import("node:fs/promises");
          await symlink(
            join(installed.consumerRoot, "node_modules", "@explodex", "sdk"),
            join(fixtureRoot, "node_modules", "@explodex", "sdk"),
          );

          await writeFixture(
            fixtureRoot,
            "src/consumer.ts",
            `import {
  defineConfig,
  definePlugin,
  SDK_VERSION,
  satisfiesSdkRange,
  type PluginApi,
  type ExplodexConfig,
} from "@explodex/sdk";

const config: ExplodexConfig = defineConfig({
  version: "2026.07.26",
  displayName: "Fixture",
  description: "external strict consumer",
  lifecycle: "dynamic",
  assets: ["notice.txt"],
});

const plugin = definePlugin({
  setup(api: PluginApi) {
    api.log.info("boot", { version: api.version });
    const stop = (): void => {
      api.log.debug("teardown");
    };
    return stop;
  },
});

const asyncPlugin = definePlugin({
  async setup(api) {
    api.log.info("async");
    return async () => {
      await Promise.resolve();
    };
  },
});

export const values = {
  config,
  plugin,
  asyncPlugin,
  version: SDK_VERSION,
  ok: satisfiesSdkRange(SDK_VERSION, "^1.2.0"),
};

// Compile-time: unknown inputs are accepted by the helper without any casts.
export function checkUnknown(version: unknown, range: unknown): boolean {
  return satisfiesSdkRange(version, range);
}
`,
          );

          const tsc = Bun.spawn([TSC, "-p", join(fixtureRoot, "tsconfig.json")], {
            cwd: fixtureRoot,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await tsc.exited;
          const stdout = await new Response(tsc.stdout).text();
          const stderr = await new Response(tsc.stderr).text();
          expect(exitCode).toBe(0);
          expect(stdout + stderr).not.toMatch(/\berror TS/);

          // Declaration scan: no explicit any in shipped .d.ts files.
          const dtsRoot = join(installed.consumerRoot, "node_modules", "@explodex", "sdk", "dist");
          const { readdir } = await import("node:fs/promises");
          async function collectDts(dir: string): Promise<string[]> {
            const out: string[] = [];
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);
              if (entry.isDirectory()) out.push(...(await collectDts(full)));
              else if (entry.name.endsWith(".d.ts")) out.push(full);
            }
            return out;
          }
          const dtsFiles = await collectDts(dtsRoot);
          expect(dtsFiles.length).toBeGreaterThan(0);
          const anyPattern = /(?<![A-Za-z0-9_])any(?![A-Za-z0-9_])/g;
          for (const file of dtsFiles) {
            const text = await readFile(file, "utf8");
            const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
            expect(stripped.match(anyPattern)).toBeNull();
          }

          // Runtime exports agree with documented value exports.
          const runtimeMod = await import(
            join(installed.consumerRoot, "node_modules", "@explodex", "sdk", "dist", "index.js")
          );
          expect(typeof runtimeMod.definePlugin).toBe("function");
          expect(typeof runtimeMod.defineConfig).toBe("function");
          expect(typeof runtimeMod.SDK_VERSION).toBe("string");
          expect(typeof runtimeMod.satisfiesSdkRange).toBe("function");
          expect(typeof runtimeMod.parseSemVer).toBe("function");
          expect(typeof runtimeMod.currentSdkSatisfiesRange).toBe("function");
        } finally {
          await rm(fixtureRoot, { recursive: true, force: true });
        }
      } finally {
        await installed.cleanup();
      }
    });
  }, 120_000);
});
