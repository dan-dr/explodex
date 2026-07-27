import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
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
  evaluateSdkCompatibility,
  satisfiesSdkRange,
  type ExplodexRuntime,
  type PluginApi,
  type ExplodexConfig,
  type TrackedEventListener,
} from "@explodex/sdk";
import type { ExplodexRuntime as RendererRuntime } from "@explodex/sdk/runtime";

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
    const callback: TrackedEventListener = (event: unknown) => {
      api.log.debug("event", event);
    };
    const target = {
      addEventListener(
        _type: string,
        _listener: TrackedEventListener | null,
        _options?: boolean | Record<string, unknown>,
      ): void {},
      removeEventListener(
        _type: string,
        _listener: TrackedEventListener | null,
        _options?: boolean | Record<string, unknown>,
      ): void {},
    };
    api.track.listen(target, "fixture", callback);
    const notice = await api.assets.open("notice.txt");
    const [text, bytes] = await Promise.all([notice.text(), notice.bytes()]);
    api.log.info(text, { bytes: bytes.byteLength });
    return async () => {
      await Promise.resolve();
    };
  },
});

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type _PluginApiIsNotAny = AssertFalse<IsAny<PluginApi>>;
type _AssetOpenIsNotAny = AssertFalse<
  IsAny<ReturnType<PluginApi["assets"]["open"]>>
>;
type _RendererRuntimeIsNotAny = AssertFalse<IsAny<RendererRuntime>>;

const runtimeShape = {} as ExplodexRuntime;
const rendererRuntimeShape: RendererRuntime = runtimeShape;

export const values = {
  config,
  plugin,
  asyncPlugin,
  rendererRuntimeShape,
  version: SDK_VERSION,
  ok: satisfiesSdkRange(SDK_VERSION, "^1.2.0"),
  compatibility: evaluateSdkCompatibility(SDK_VERSION, "^1.2.0"),
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

          // Declaration-derived value exports must agree exactly with runtime keys.
          const packageRoot = join(
            installed.consumerRoot,
            "node_modules",
            "@explodex",
            "sdk",
          );
          const declarationPath = join(packageRoot, "dist", "index.d.ts");
          const program = ts.createProgram(
            [declarationPath],
            {
              module: ts.ModuleKind.NodeNext,
              moduleResolution: ts.ModuleResolutionKind.NodeNext,
              strict: true,
              skipLibCheck: false,
              types: [],
            },
          );
          const checker = program.getTypeChecker();
          const sourceFile = program.getSourceFile(declarationPath);
          expect(sourceFile).toBeDefined();
          const moduleSymbol =
            sourceFile === undefined
              ? undefined
              : checker.getSymbolAtLocation(sourceFile);
          expect(moduleSymbol).toBeDefined();
          const declaredValueExports = (moduleSymbol === undefined
            ? []
            : checker.getExportsOfModule(moduleSymbol)
          )
            .filter((symbol) => {
              const target =
                symbol.flags & ts.SymbolFlags.Alias
                  ? checker.getAliasedSymbol(symbol)
                  : symbol;
              return (target.flags & ts.SymbolFlags.Value) !== 0;
            })
            .map((symbol) => symbol.name)
            .sort();

          const runtimeMod = await import(join(packageRoot, "dist", "index.js"));
          expect(Object.keys(runtimeMod).sort()).toEqual(declaredValueExports);
        } finally {
          await rm(fixtureRoot, { recursive: true, force: true });
        }
      } finally {
        await installed.cleanup();
      }
    });
  }, 120_000);
});
