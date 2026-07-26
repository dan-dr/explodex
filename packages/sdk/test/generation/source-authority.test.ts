import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      const indexDtsPath = join(sandbox, "dist", "index.d.ts");
      const beforeRuntime = await hashFile(runtimePath);
      const beforeVersionDts = await hashFile(versionDtsPath);
      const beforeIndexDts = await hashFile(indexDtsPath);
      const beforeRuntimeText = await readFile(runtimePath, "utf8");

      // Value-bearing change: runtime version string.
      const versionSourcePath = join(sandbox, "src", "runtime", "version.ts");
      const versionSource = await readFile(versionSourcePath, "utf8");
      await writeFile(
        versionSourcePath,
        versionSource.replace(/"1\.2\.0"/, '"1.2.0-test"'),
        "utf8",
      );
      // Keep authoring version in sync for package consistency checks in other tests;
      // here we only need the runtime value to change.
      const second = await runBuild(sandbox);
      expect(second.exitCode).toBe(0);
      const afterRuntimeText = await readFile(runtimePath, "utf8");
      expect(afterRuntimeText).toContain("1.2.0-test");
      expect(afterRuntimeText).not.toBe(beforeRuntimeText);
      expect(await hashFile(runtimePath)).not.toBe(beforeRuntime);

      // Restore value, then type-only change on authoring surface.
      await writeFile(versionSourcePath, versionSource, "utf8");
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

      // Drift gate: hand-edit generated output, rebuild overwrites it.
      await writeFile(runtimePath, `${restoredRuntime}\n/* hand-edited drift */\n`, "utf8");
      const driftedHash = await hashFile(runtimePath);
      const fourth = await runBuild(sandbox);
      expect(fourth.exitCode).toBe(0);
      const cleaned = await readFile(runtimePath, "utf8");
      expect(cleaned.includes("hand-edited drift")).toBe(false);
      expect(await hashFile(runtimePath)).not.toBe(driftedHash);

      // Deleting a generated file is restored.
      await rm(versionDtsPath, { force: true });
      const fifth = await runBuild(sandbox);
      expect(fifth.exitCode).toBe(0);
      await readFile(versionDtsPath, "utf8");
      expect(await hashFile(versionDtsPath)).toBeTruthy();
      expect(beforeVersionDts).toBeTruthy();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 180_000);
});
