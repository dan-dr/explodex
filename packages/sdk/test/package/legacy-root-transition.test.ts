import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers/pack.ts";

const LEGACY_RUNTIME = "sdk/explodex-sdk.js";
const LEGACY_TYPES = "sdk/explodex-sdk.d.ts";
const GENERATED_RUNTIME =
  "packages/sdk/dist/runtime/explodex-runtime.iife.js";

describe("M2-F01R legacy root SDK transition boundary", () => {
  test("root npm package cannot publish the legacy SDK as an active surface", async () => {
    const packageJson = JSON.parse(
      await readFile(join(REPO_ROOT, "package.json"), "utf8"),
    ) as {
      types?: unknown;
      files?: unknown;
      scripts?: { prepack?: unknown };
    };

    expect(packageJson.types).not.toBe(LEGACY_TYPES);
    expect(Array.isArray(packageJson.files)).toBe(true);
    expect(packageJson.files).not.toContain(LEGACY_RUNTIME);
    expect(packageJson.files).not.toContain(LEGACY_TYPES);
    expect(packageJson.files).toContain(
      "packages/sdk/dist/runtime/explodex-runtime.iife.js",
    );
    expect(String(packageJson.scripts?.prepack ?? "")).not.toContain("sdk/explodex-sdk");
  });

  test("active build, validation, and runtime resolution use packages/sdk output", async () => {
    const files = [
      "scripts/package-app.ts",
      "scripts/cdp-inject.ts",
      "scripts/launch.sh",
      "scripts/validate.sh",
      "lib/paths.mjs",
      "packages/cli/src/host/sdk-runtime-identity.ts",
    ] as const;

    for (const relativePath of files) {
      const source = await readFile(join(REPO_ROOT, relativePath), "utf8");
      expect(source).not.toContain(LEGACY_RUNTIME);
      expect(source).not.toContain(LEGACY_TYPES);
    }

    const packageApp = await readFile(
      join(REPO_ROOT, "scripts/package-app.ts"),
      "utf8",
    );
    const injector = await readFile(
      join(REPO_ROOT, "scripts/cdp-inject.ts"),
      "utf8",
    );
    const launcher = await readFile(
      join(REPO_ROOT, "scripts/launch.sh"),
      "utf8",
    );
    const runtimeIdentity = await readFile(
      join(REPO_ROOT, "packages/cli/src/host/sdk-runtime-identity.ts"),
      "utf8",
    );

    expect(packageApp).toContain(GENERATED_RUNTIME);
    expect(injector).toContain(GENERATED_RUNTIME);
    expect(launcher).toContain(GENERATED_RUNTIME);
    expect(runtimeIdentity).toContain(
      '"sdk", "dist", "runtime", "explodex-runtime.iife.js"',
    );
    expect(runtimeIdentity).not.toContain("Transitional root");
  });
});
