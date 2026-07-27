import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSdkPackage, SDK_PACKAGE_ROOT } from "../helpers/pack.ts";

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

const REPO_ROOT = join(SDK_PACKAGE_ROOT, "..", "..");
const REPO_TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");

async function runBuild(cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Isolated copies are outside the monorepo; pin the monorepo tsc binary.
      EXPLODEX_TSC: REPO_TSC,
    },
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

describe("VAL-SDK-003 one generated source authority", () => {
  test("value and type-only source changes drive generated outputs; drift is overwritten", async () => {
    await buildSdkPackage();

    const sandbox = await mkdtemp(join(tmpdir(), "explodex-sdk-authority-"));
    try {
      // Copy package sources (not node_modules/dist) into an isolated tree.
      await mkdir(sandbox, { recursive: true });
      for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json", "src", "scripts"]) {
        await cp(join(SDK_PACKAGE_ROOT, name), join(sandbox, name), { recursive: true });
      }

      const first = await runBuild(sandbox);
      expect(first.exitCode).toBe(0);

      const runtimePath = join(sandbox, "dist", "runtime", "explodex-runtime.iife.js");
      const versionDtsPath = join(sandbox, "dist", "version.d.ts");
      const versionJsPath = join(sandbox, "dist", "version.js");
      const indexDtsPath = join(sandbox, "dist", "index.d.ts");
      const runtimePublicDtsPath = join(sandbox, "dist", "runtime", "public.d.ts");
      const runtimePublicDtsMapPath = join(
        sandbox,
        "dist",
        "runtime",
        "public.d.ts.map",
      );
      const beforeRuntime = await hashFile(runtimePath);
      const beforeVersionDts = await hashFile(versionDtsPath);
      const beforeIndexDts = await hashFile(indexDtsPath);
      const beforeRuntimeText = await readFile(runtimePath, "utf8");

      // Value-bearing version change: one TS version source feeds authoring JS,
      // declarations, the renderer IIFE, and package metadata validation.
      const versionSourcePath = join(sandbox, "src", "version.ts");
      const versionSource = await readFile(versionSourcePath, "utf8");
      const packageJsonPath = join(sandbox, "package.json");
      const packageJson = await readFile(packageJsonPath, "utf8");
      await writeFile(
        versionSourcePath,
        versionSource.replace(/"1\.2\.0"/, '"1.2.0-test"'),
        "utf8",
      );
      await writeFile(
        packageJsonPath,
        packageJson.replace('"version": "1.2.0"', '"version": "1.2.0-test"'),
        "utf8",
      );
      const second = await runBuild(sandbox);
      expect(second.exitCode).toBe(0);
      const afterRuntimeText = await readFile(runtimePath, "utf8");
      expect(afterRuntimeText).toContain("1.2.0-test");
      expect(afterRuntimeText).not.toBe(beforeRuntimeText);
      expect(await hashFile(runtimePath)).not.toBe(beforeRuntime);
      expect(await readFile(versionJsPath, "utf8")).toContain("1.2.0-test");
      expect(await readFile(versionDtsPath, "utf8")).toContain("1.2.0-test");

      // Restore value and package metadata, then change a public authoring type.
      await writeFile(versionSourcePath, versionSource, "utf8");
      await writeFile(packageJsonPath, packageJson, "utf8");
      const pluginTypesPath = join(sandbox, "src", "types", "plugin.ts");
      const pluginTypes = await readFile(pluginTypesPath, "utf8");
      await writeFile(
        pluginTypesPath,
        `${pluginTypes}\n/** Type-only probe for generation drift. */\nexport type GenerationProbe = { readonly probe: true };\n`,
        "utf8",
      );
      const typesIndexPath = join(sandbox, "src", "types", "index.ts");
      const typesIndex = await readFile(typesIndexPath, "utf8");
      await writeFile(
        typesIndexPath,
        typesIndex.replace(
          'export type {\n  DefinedPlugin,',
          'export type {\n  GenerationProbe,\n  DefinedPlugin,',
        ),
        "utf8",
      );
      const rootIndexPath = join(sandbox, "src", "index.ts");
      const rootIndex = await readFile(rootIndexPath, "utf8");
      await writeFile(
        rootIndexPath,
        rootIndex.replace(
          "export type {\n  ArtifactVersion,",
          "export type {\n  GenerationProbe,\n  ArtifactVersion,",
        ),
        "utf8",
      );

      const third = await runBuild(sandbox);
      expect(third.exitCode).toBe(0);
      const afterIndexDts = await readFile(indexDtsPath, "utf8");
      expect(afterIndexDts).toContain("GenerationProbe");
      // Runtime may rebuild but version value is restored.
      const restoredRuntime = await readFile(runtimePath, "utf8");
      expect(restoredRuntime).toContain("1.2.0");
      expect(restoredRuntime).not.toContain("1.2.0-test");
      expect(await hashFile(indexDtsPath)).not.toBe(beforeIndexDts);

      // A runtime-public type-only change updates declarations/maps without
      // requiring a renderer runtime value change.
      const runtimePublicSourcePath = join(
        sandbox,
        "src",
        "runtime",
        "public.ts",
      );
      const runtimePublicSource = await readFile(runtimePublicSourcePath, "utf8");
      const runtimeBeforeTypeChange = await hashFile(runtimePath);
      await writeFile(
        runtimePublicSourcePath,
        runtimePublicSource.replace(
          "readonly version: string;",
          "readonly version: string;\n  readonly generationProbe?: true;",
        ),
        "utf8",
      );
      const runtimeTypeChange = await runBuild(sandbox);
      expect(runtimeTypeChange.exitCode).toBe(0);
      expect(await readFile(runtimePublicDtsPath, "utf8")).toContain(
        "generationProbe?: true",
      );
      expect(await readFile(runtimePublicDtsMapPath, "utf8")).toContain(
        "src/runtime/public.ts",
      );
      expect(await hashFile(runtimePath)).toBe(runtimeBeforeTypeChange);

      // Drift gate: hand-edit generated output, rebuild overwrites it.
      await writeFile(runtimePath, `${restoredRuntime}\n/* hand-edited drift */\n`, "utf8");
      await writeFile(join(sandbox, "dist", "extra-generated.js"), "extra\n", "utf8");
      const driftedHash = await hashFile(runtimePath);
      const fourth = await runBuild(sandbox);
      expect(fourth.exitCode).toBe(0);
      const cleaned = await readFile(runtimePath, "utf8");
      expect(cleaned.includes("hand-edited drift")).toBe(false);
      expect(await hashFile(runtimePath)).not.toBe(driftedHash);
      expect(await readdir(join(sandbox, "dist"))).not.toContain(
        "extra-generated.js",
      );

      // Deleting a generated file is restored.
      await rm(versionDtsPath, { force: true });
      const fifth = await runBuild(sandbox);
      expect(fifth.exitCode).toBe(0);
      await readFile(versionDtsPath, "utf8");
      expect(await hashFile(versionDtsPath)).toBeTruthy();
      expect(beforeVersionDts).toBeTruthy();

      // Package metadata cannot diverge from the TS version authority.
      const divergentPackageJson = (await readFile(packageJsonPath, "utf8")).replace(
        '"version": "1.2.0"',
        '"version": "9.9.9"',
      );
      await writeFile(packageJsonPath, divergentPackageJson, "utf8");
      const mismatch = await runBuild(sandbox);
      expect(mismatch.exitCode).not.toBe(0);
      expect(mismatch.stderr).toContain("SDK version authority mismatch");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 180_000);
});
