import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInertRegistrationHarness } from "@explodex/sdk/testing";

const registryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(registryRoot, "../..");

const expectedWorkspaces = [
  "explodex-plugin-command-menu-threads",
  "explodex-plugin-effort-shortcuts",
  "explodex-plugin-feature-flags-playground",
  "explodex-plugin-project-colors",
  "explodex-plugin-project-pins",
  "explodex-plugin-toggle-autoscroll",
  "explodex-plugin-usage-reset-glance",
];

const migratedWorkspaces = [
  "explodex-plugin-toggle-autoscroll",
  "explodex-plugin-project-colors",
  "explodex-plugin-command-menu-threads",
];

const migratedPluginIds = {
  "explodex-plugin-toggle-autoscroll": "toggle-autoscroll",
  "explodex-plugin-project-colors": "project-colors",
  "explodex-plugin-command-menu-threads": "command-menu-threads",
} as const;

const forbiddenPrivateMarkers = [
  "__EXPLODEX_BRIDGE__",
  "__reactContainer$",
  "__reactFiber$",
  "electronBridge",
  "ReactQuery",
  "Statsig",
];

describe("VAL-PLUG-001 registry workspace topology", () => {
  test("contains exactly seven direct explodex-plugin-* child workspaces", async () => {
    const directChildren = (await readdir(registryRoot, {
      withFileTypes: true,
    }))
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("explodex-plugin-"),
      )
      .map((entry) => entry.name)
      .sort();
    expect(directChildren).toEqual(expectedWorkspaces);
    for (const workspace of expectedWorkspaces) {
      const requiredFiles = [
        "package.json",
        "explodex.config.ts",
        "src/index.ts",
      ];
      for (const relative of requiredFiles) {
        expect(
          await readFile(join(registryRoot, workspace, relative), "utf8"),
        ).not.toBe("");
      }
    }
  });

  test("is reproducible from root and registry workspace declarations", async () => {
    const rootPackage = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces?: string[] };
    const registryPackage = JSON.parse(
      await readFile(join(registryRoot, "package.json"), "utf8"),
    ) as { workspaces?: string[] };
    expect(rootPackage.workspaces).toContain("packages/plugin-registry");
    expect(rootPackage.workspaces).toContain(
      "packages/plugin-registry/explodex-plugin-*",
    );
    expect(registryPackage.workspaces).toEqual(["explodex-plugin-*"]);
  });
});

describe("VAL-PLUG-002 public SDK boundary", () => {
  test("all first-party workspaces resolve through public SDK package imports", async () => {
    for (const workspace of expectedWorkspaces) {
      const source = await readFile(
        join(registryRoot, workspace, "src", "index.ts"),
        "utf8",
      );
      const packageJson = JSON.parse(
        await readFile(join(registryRoot, workspace, "package.json"), "utf8"),
      ) as {
        peerDependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(source).toContain('from "@explodex/sdk"');
      expect(packageJson.peerDependencies?.["@explodex/sdk"]).toBe("^1.2.0");
      expect(packageJson.devDependencies?.["@explodex/sdk"]).toBe("1.2.0");
      expect(source).not.toMatch(
        /(?:\.\.\/)+(?:sdk|plugins)\b|(?:^|["'])\/.*\/sdk\b/,
      );
      for (const marker of forbiddenPrivateMarkers) {
        expect(source).not.toContain(marker);
      }
    }
  });

  test("migrated generated bundles avoid private renderer globals", async () => {
    for (const workspace of migratedWorkspaces) {
      const bundle = await readFile(
        join(registryRoot, workspace, "dist", "index.js"),
        "utf8",
      );
      for (const marker of forbiddenPrivateMarkers) {
        expect(bundle).not.toContain(marker);
      }
    }
  });
});

describe("VAL-PLUG-003 inert generated bundles", () => {
  test("each bundle registers once without top-level host side effects", async () => {
    for (const [workspace, pluginId] of Object.entries(migratedPluginIds)) {
      const source = await readFile(
        join(registryRoot, workspace, "dist", "index.js"),
        "utf8",
      );
      const harness = createInertRegistrationHarness();
      const result = await harness.evaluateSource({
        expectedPluginId: pluginId,
        source,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.registrationCount).toBe(1);
      expect(result.sideEffects).toEqual({
        domMutations: 0,
        networkCalls: 0,
        storageMutations: 0,
        timerRegistrations: 0,
        hostActions: 0,
        globalMutations: 0,
        setupCalls: 0,
      });
    }
  });
});
