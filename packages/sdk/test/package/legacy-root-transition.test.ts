import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers/pack.ts";

const LEGACY_RUNTIME = "sdk/explodex-sdk.js";
const LEGACY_TYPES = "sdk/explodex-sdk.d.ts";
const GENERATED_RUNTIME =
  "packages/sdk/dist/runtime/explodex-runtime.iife.js";

describe("M2-F01R legacy root SDK transition boundary", () => {
  test("root workspace is private and cannot publish legacy SDK files", async () => {
    const packageJson = JSON.parse(
      await readFile(join(REPO_ROOT, "package.json"), "utf8"),
    ) as {
      private?: unknown;
      files?: unknown;
      scripts?: { prepack?: unknown };
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.files).toBeUndefined();
    expect(String(packageJson.scripts?.prepack ?? "")).not.toContain("sdk/explodex-sdk");
  });

  test("legacy root distribution surfaces are absent", async () => {
    const legacyPaths = [
      LEGACY_RUNTIME,
      LEGACY_TYPES,
      "bin/explodex.mjs",
      "scripts/package-app.ts",
      "scripts/cdp-inject.ts",
      "scripts/launch.sh",
      "plugins",
    ] as const;

    for (const relativePath of legacyPaths) {
      await expect(access(join(REPO_ROOT, relativePath))).rejects.toThrow();
    }
  });

  test("runtime resolution uses the published SDK package", async () => {
    const runtimeIdentity = await readFile(
      join(REPO_ROOT, "packages/cli/src/host/sdk-runtime-identity.ts"),
      "utf8",
    );

    expect(GENERATED_RUNTIME).toBe("packages/sdk/dist/runtime/explodex-runtime.iife.js");
    expect(runtimeIdentity).toContain(
      'require.resolve("@explodex/sdk/package.json")',
    );
    expect(runtimeIdentity).not.toContain("monorepoCandidates");
    expect(runtimeIdentity).not.toContain("Transitional root");
  });
});
