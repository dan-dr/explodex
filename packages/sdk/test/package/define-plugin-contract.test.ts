import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, isDefinedPlugin } from "../../src/define-plugin.ts";
import type { PluginApi } from "../../src/types/plugin.ts";
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

async function typecheckFixture(source: string): Promise<{ exitCode: number; output: string }> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "explodex-define-plugin-tsc-"));
  try {
    await writeFixture(
      fixtureRoot,
      "package.json",
      `${JSON.stringify({ name: "define-plugin-fixture", private: true, type: "module" }, null, 2)}\n`,
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
    await writeFixture(fixtureRoot, "src/consumer.ts", source);

    // Resolve against the monorepo built package via symlink for type-only fixtures.
    await mkdir(join(fixtureRoot, "node_modules", "@explodex"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(
      join(REPO_ROOT, "packages", "sdk"),
      join(fixtureRoot, "node_modules", "@explodex", "sdk"),
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
    return { exitCode, output: stdout + stderr };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

describe("VAL-SDK-009 definePlugin exact typed lifecycle contract", () => {
  test("runtime accepts sync void, teardown, and async setup/teardown without invoking setup", () => {
    let called = 0;
    const syncVoid = definePlugin({
      setup(_api: PluginApi) {
        called += 1;
      },
    });
    const syncTeardown = definePlugin({
      setup(_api) {
        called += 1;
        return () => {
          called += 1;
        };
      },
    });
    const asyncTeardown = definePlugin({
      async setup(_api) {
        called += 1;
        return async () => {
          called += 1;
        };
      },
    });

    expect(isDefinedPlugin(syncVoid)).toBe(true);
    expect(isDefinedPlugin(syncTeardown)).toBe(true);
    expect(isDefinedPlugin(asyncTeardown)).toBe(true);
    expect(called).toBe(0);
    expect(typeof syncVoid.setup).toBe("function");
  });

  test("runtime rejects missing setup, non-objects, and unknown fields", () => {
    expect(() => definePlugin(null as never)).toThrow(/plugin definition object/);
    expect(() => definePlugin(undefined as never)).toThrow(/plugin definition object/);
    expect(() => definePlugin({} as never)).toThrow(/requires setup\(api\)/);
    expect(() =>
      definePlugin({ setup: "nope" } as never),
    ).toThrow(/requires setup\(api\)/);
    expect(() =>
      definePlugin({ setup() {}, name: "x" } as never),
    ).toThrow(/unknown field "name"/);
    expect(() =>
      definePlugin({ setup() {}, id: "x" } as never),
    ).toThrow(/unknown field "id"/);
  });

  test("strict external fixtures accept valid sync/async lifecycle shapes", async () => {
    await buildSdkPackage();
    const valid = await typecheckFixture(`import { definePlugin, type PluginApi } from "@explodex/sdk";

export const a = definePlugin({
  setup(api: PluginApi) {
    api.log.info("sync-void");
  },
});

export const b = definePlugin({
  setup(api) {
    return () => {
      api.log.debug("sync-teardown");
    };
  },
});

export const c = definePlugin({
  async setup(api) {
    api.log.info("async-setup");
    return async () => {
      await Promise.resolve();
    };
  },
});

export const d = definePlugin({
  setup() {
    return async () => {};
  },
});
`);
    expect(valid.exitCode).toBe(0);
    expect(valid.output).not.toMatch(/\berror TS/);
  }, 60_000);

  test("strict external fixtures reject missing setup, wrong types, and unknown fields", async () => {
    await buildSdkPackage();

    const missingSetup = await typecheckFixture(`import { definePlugin } from "@explodex/sdk";
export const bad = definePlugin({});
`);
    expect(missingSetup.exitCode).not.toBe(0);
    expect(missingSetup.output).toMatch(/setup/i);

    const wrongApi = await typecheckFixture(`import { definePlugin } from "@explodex/sdk";
export const bad = definePlugin({
  setup(api: number) {
    return api;
  },
});
`);
    expect(wrongApi.exitCode).not.toBe(0);

    const invalidReturn = await typecheckFixture(`import { definePlugin } from "@explodex/sdk";
export const bad = definePlugin({
  setup() {
    return 123;
  },
});
`);
    expect(invalidReturn.exitCode).not.toBe(0);

    const unknownField = await typecheckFixture(`import { definePlugin } from "@explodex/sdk";
export const bad = definePlugin({
  setup() {},
  extra: true,
});
`);
    expect(unknownField.exitCode).not.toBe(0);
    expect(unknownField.output).toMatch(/extra|not assignable|unknown/i);

    const invalidTeardown = await typecheckFixture(`import { definePlugin } from "@explodex/sdk";
export const bad = definePlugin({
  setup() {
    return () => 123;
  },
});
`);
    expect(invalidTeardown.exitCode).not.toBe(0);
  }, 120_000);

  test("packed declarations expose the same contract without private imports", async () => {
    await buildSdkPackage();
    await withTempDir("explodex-define-plugin-pack-", async (dir) => {
      const { tarballPath } = await packSdkActual(dir);
      const installed = await installSdkFromTarball(tarballPath);
      try {
        const mod = await import(
          join(installed.consumerRoot, "node_modules", "@explodex", "sdk", "dist", "index.js")
        );
        expect(typeof mod.definePlugin).toBe("function");
        expect(typeof mod.isDefinedPlugin).toBe("function");
        const defined = mod.definePlugin({
          setup() {
            return;
          },
        });
        expect(mod.isDefinedPlugin(defined)).toBe(true);
        expect(mod.isDefinedPlugin({})).toBe(false);
      } finally {
        await installed.cleanup();
      }
    });
  }, 120_000);
});
