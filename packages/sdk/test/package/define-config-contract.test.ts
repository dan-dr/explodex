import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/define-config.ts";
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
  const fixtureRoot = await mkdtemp(join(tmpdir(), "explodex-define-config-tsc-"));
  try {
    await writeFixture(
      fixtureRoot,
      "package.json",
      `${JSON.stringify({ name: "define-config-fixture", private: true, type: "module" }, null, 2)}\n`,
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

describe("VAL-SDK-010 defineConfig canonical authoring metadata", () => {
  test("accepts canonical metadata and freezes the normalized result", () => {
    const config = defineConfig({
      version: "2026.07.26",
      displayName: "Fixture Plugin",
      description: "canonical metadata only",
      lifecycle: "dynamic",
      entry: "src/index.ts",
      assets: ["notice.txt"],
    });
    expect(config).toEqual({
      version: "2026.07.26",
      displayName: "Fixture Plugin",
      description: "canonical metadata only",
      lifecycle: "dynamic",
      entry: "src/index.ts",
      assets: ["notice.txt"],
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.assets)).toBe(true);
  });

  test("accepts each supported lifecycle", () => {
    for (const lifecycle of ["dynamic", "renderer-start", "app-start"] as const) {
      const config = defineConfig({
        version: "1",
        displayName: "L",
        description: "",
        lifecycle,
      });
      expect(config.lifecycle).toBe(lifecycle);
    }
  });

  test("rejects id, sdkRange, permissions, and unknown fields at runtime", () => {
    expect(() =>
      defineConfig({
        version: "1",
        displayName: "x",
        description: "",
        lifecycle: "dynamic",
        id: "stolen",
      } as never),
    ).toThrow(/does not accept id/);

    expect(() =>
      defineConfig({
        version: "1",
        displayName: "x",
        description: "",
        lifecycle: "dynamic",
        sdkRange: "^1.0.0",
      } as never),
    ).toThrow(/does not accept sdkRange/);

    expect(() =>
      defineConfig({
        version: "1",
        displayName: "x",
        description: "",
        lifecycle: "dynamic",
        permissions: ["all"],
      } as never),
    ).toThrow(/permissions/);

    expect(() =>
      defineConfig({
        version: "1",
        displayName: "x",
        description: "",
        lifecycle: "dynamic",
        capabilities: ["ui"],
      } as never),
    ).toThrow(/capabilities/);

    expect(() =>
      defineConfig({
        version: "1",
        displayName: "x",
        description: "",
        lifecycle: "dynamic",
        repository: "https://example.com",
      } as never),
    ).toThrow(/repository/);

    expect(() =>
      defineConfig({
        version: "1",
        displayName: "x",
        description: "",
        lifecycle: "dynamic",
        extra: true,
      } as never),
    ).toThrow(/unknown field "extra"/);

    expect(() =>
      defineConfig({
        version: "",
        displayName: "x",
        description: "",
        lifecycle: "dynamic",
      }),
    ).toThrow(/non-empty version/);

    expect(() =>
      defineConfig({
        version: "1",
        displayName: "x",
        description: "",
        lifecycle: "never" as never,
      }),
    ).toThrow(/lifecycle must be/);
  });

  test("strict external fixtures accept only canonical fields", async () => {
    await buildSdkPackage();
    const valid = await typecheckFixture(`import { defineConfig, type ExplodexConfig } from "@explodex/sdk";

export const config: ExplodexConfig = defineConfig({
  version: "2026.07.26",
  displayName: "External",
  description: "packed types",
  lifecycle: "renderer-start",
  entry: "src/index.ts",
  assets: ["a.txt"],
});
`);
    expect(valid.exitCode).toBe(0);
    expect(valid.output).not.toMatch(/\berror TS/);
  }, 60_000);

  test("strict external fixtures reject id, sdkRange, and unknown fields", async () => {
    await buildSdkPackage();

    const withId = await typecheckFixture(`import { defineConfig } from "@explodex/sdk";
export const bad = defineConfig({
  version: "1",
  displayName: "x",
  description: "",
  lifecycle: "dynamic",
  id: "nope",
});
`);
    expect(withId.exitCode).not.toBe(0);
    expect(withId.output).toMatch(/id/i);

    const withRange = await typecheckFixture(`import { defineConfig } from "@explodex/sdk";
export const bad = defineConfig({
  version: "1",
  displayName: "x",
  description: "",
  lifecycle: "dynamic",
  sdkRange: "^1.0.0",
});
`);
    expect(withRange.exitCode).not.toBe(0);
    expect(withRange.output).toMatch(/sdkRange/i);

    const unknown = await typecheckFixture(`import { defineConfig } from "@explodex/sdk";
export const bad = defineConfig({
  version: "1",
  displayName: "x",
  description: "",
  lifecycle: "dynamic",
  permissions: [],
});
`);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.output).toMatch(/permissions|not assignable|unknown/i);

    const badLifecycle = await typecheckFixture(`import { defineConfig } from "@explodex/sdk";
export const bad = defineConfig({
  version: "1",
  displayName: "x",
  description: "",
  lifecycle: "always",
});
`);
    expect(badLifecycle.exitCode).not.toBe(0);
  }, 120_000);

  test("packed runtime exports defineConfig without mutating output tree on rejection", async () => {
    await buildSdkPackage();
    await withTempDir("explodex-define-config-pack-", async (dir) => {
      const { tarballPath } = await packSdkActual(dir);
      const installed = await installSdkFromTarball(tarballPath);
      try {
        const mod = await import(
          join(installed.consumerRoot, "node_modules", "@explodex", "sdk", "dist", "index.js")
        );
        expect(typeof mod.defineConfig).toBe("function");
        const ok = mod.defineConfig({
          version: "1.0.0",
          displayName: "Packed",
          description: "ok",
          lifecycle: "app-start",
        });
        expect(ok.lifecycle).toBe("app-start");
        expect(() =>
          mod.defineConfig({
            version: "1.0.0",
            displayName: "Packed",
            description: "ok",
            lifecycle: "dynamic",
            id: "x",
          }),
        ).toThrow(/id/);
      } finally {
        await installed.cleanup();
      }
    });
  }, 120_000);
});
