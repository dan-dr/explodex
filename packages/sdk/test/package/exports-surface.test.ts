import { describe, expect, test } from "bun:test";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSdkPackage,
  installSdkFromTarball,
  listTarballPaths,
  packSdkActual,
  packSdkDryRun,
  withTempDir,
} from "../helpers/pack.ts";

const PUBLIC_EXPORTS = [".", "./runtime", "./testing", "./package.json"] as const;

async function resolveFromConsumer(
  consumerRoot: string,
  specifier: string,
  conditions: readonly string[] = [],
): Promise<string> {
  // Use Node's ESM resolver so import-only export conditions are honored.
  const proc = Bun.spawn(
    [
      "node",
      ...conditions.map((condition) => `--conditions=${condition}`),
      "--input-type=module",
      "-e",
      `const url = await import.meta.resolve(${JSON.stringify(specifier)}, ${JSON.stringify(
        pathToFileURL(join(consumerRoot, "package.json")).href,
      )}); process.stdout.write(url);`,
    ],
    {
      cwd: consumerRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`import.meta.resolve failed for ${specifier}: ${stderr || stdout}`);
  }
  const href = stdout.trim();
  return href.startsWith("file:") ? fileURLToPath(href) : href;
}

describe("VAL-SDK-001 packed SDK public surface", () => {
  test("dry-run and actual tarball expose only condition-safe documented paths", async () => {
    await buildSdkPackage();
    const dryRun = await packSdkDryRun();
    const dryPaths = new Set(dryRun.files.map((file) => file.path));

    // package.json must declare the documented exports.
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as {
      exports: Record<string, unknown>;
      types?: string;
      files?: string[];
    };
    for (const key of PUBLIC_EXPORTS) {
      expect(packageJson.exports[key]).toBeDefined();
    }
    expect(packageJson.exports["./src/index.js"]).toBeUndefined();
    expect(packageJson.exports["./src/*"]).toBeUndefined();

    // Root/testing exports are Node-safe ESM. The runtime value is browser-only.
    const rootExport = packageJson.exports["."] as Record<string, string>;
    expect(rootExport.types).toBe("./dist/index.d.ts");
    expect(rootExport.import).toBe("./dist/index.js");
    const runtimeExport = packageJson.exports["./runtime"] as Record<string, string>;
    expect(runtimeExport.types).toBe("./dist/runtime/public.d.ts");
    expect(runtimeExport.browser).toBe("./dist/runtime/explodex-runtime.iife.js");
    expect(runtimeExport.import).toBeUndefined();
    expect(runtimeExport.default).toBeUndefined();
    const testingExport = packageJson.exports["./testing"] as Record<string, string>;
    expect(testingExport.types).toBe("./dist/testing/index.d.ts");
    expect(testingExport.import).toBe("./dist/testing/index.js");

    // npm pack --json dry-run paths are package-relative (no "package/" prefix).
    // Actual tarball entries use the "package/" root.
    for (const path of dryPaths) {
      expect(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)).toBe(false);
      expect(path.includes("src/")).toBe(false);
      expect(path.includes("test/")).toBe(false);
      expect(path.includes("node_modules")).toBe(false);
      expect(path.includes("scripts/")).toBe(false);
    }
    expect(dryPaths.has("package.json")).toBe(true);
    expect(dryPaths.has("dist/index.js")).toBe(true);
    expect(dryPaths.has("dist/index.d.ts")).toBe(true);
    expect(dryPaths.has("dist/runtime/explodex-runtime.iife.js")).toBe(true);

    await withTempDir("explodex-sdk-pack-", async (dir) => {
      const { tarballPath, listing } = await packSdkActual(dir);
      const tarPaths = await listTarballPaths(tarballPath);
      expect(tarPaths).toContain("package/package.json");
      expect(tarPaths).toContain("package/dist/index.js");
      expect(tarPaths).toContain("package/dist/runtime/explodex-runtime.iife.js");
      expect(tarPaths.some((path) => path.includes("/src/") || path.endsWith("/src"))).toBe(false);
      expect(listing.name).toBe("@explodex/sdk");

      const installed = await installSdkFromTarball(tarballPath);
      try {
        const resolvedRoot = await resolveFromConsumer(installed.consumerRoot, "@explodex/sdk");
        const resolvedPkg = await resolveFromConsumer(
          installed.consumerRoot,
          "@explodex/sdk/package.json",
        );
        expect(resolvedRoot.includes("node_modules/@explodex/sdk")).toBe(true);
        expect(resolvedPkg.includes("node_modules/@explodex/sdk")).toBe(true);

        // Public ESM import resolves and exports the authoring surface.
        const mod = (await import(pathToFileURL(resolvedRoot).href)) as {
          definePlugin: unknown;
          defineConfig: unknown;
          SDK_VERSION: string;
          satisfiesSdkRange: unknown;
        };
        expect(typeof mod.definePlugin).toBe("function");
        expect(typeof mod.defineConfig).toBe("function");
        expect(typeof mod.SDK_VERSION).toBe("string");
        expect(typeof mod.satisfiesSdkRange).toBe("function");

        // Ordinary Node resolution must never select the renderer IIFE.
        await expect(
          resolveFromConsumer(installed.consumerRoot, "@explodex/sdk/runtime"),
        ).rejects.toThrow();

        // The declared browser condition resolves to the IIFE artifact.
        const runtimeResolved = await resolveFromConsumer(
          installed.consumerRoot,
          "@explodex/sdk/runtime",
          ["browser"],
        );
        expect(runtimeResolved.endsWith("explodex-runtime.iife.js")).toBe(true);
        expect(
          (await realpath(runtimeResolved)).startsWith(
            `${await realpath(installed.consumerRoot)}/`,
          ),
        ).toBe(true);
        const runtimeSource = await readFile(runtimeResolved, "utf8");
        expect(runtimeSource.includes("sourceMappingURL=")).toBe(true);
        // Authoring module must not be the IIFE.
        const authoringSource = await readFile(resolvedRoot, "utf8");
        expect(authoringSource.includes("sourceMappingURL=explodex-runtime.iife.js.map")).toBe(
          false,
        );
        expect(resolvedRoot === runtimeResolved).toBe(false);

        const testingResolved = await resolveFromConsumer(
          installed.consumerRoot,
          "@explodex/sdk/testing",
        );
        expect(testingResolved.endsWith("dist/testing/index.js")).toBe(true);
        expect(
          (await realpath(testingResolved)).startsWith(
            `${await realpath(installed.consumerRoot)}/`,
          ),
        ).toBe(true);

        // Undeclared deep imports must fail package resolution.
        for (const deep of [
          "@explodex/sdk/src/index.js",
          "@explodex/sdk/dist/define-plugin.js",
          "@explodex/sdk/runtime/bootstrap",
          "@explodex/sdk/internal",
        ]) {
          await expect(resolveFromConsumer(installed.consumerRoot, deep)).rejects.toThrow();
        }

        // types condition target exists inside the package.
        const typesPath = join(
          installed.consumerRoot,
          "node_modules",
          "@explodex",
          "sdk",
          "dist",
          "index.d.ts",
        );
        await access(typesPath);
      } finally {
        await installed.cleanup();
      }
    });
  }, 120_000);
});
