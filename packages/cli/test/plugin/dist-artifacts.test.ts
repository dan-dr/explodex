import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import {
  fingerprintDistTree,
  GENERATION_FILE,
  INSTALLABLE_ROOT_FILES,
} from "../../src/plugin/dist-files.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import { computePayloadSha256, readChecksums } from "../../src/plugin/checksums.ts";
import {
  createValidWorkspace,
  writeWorkspaceFile,
} from "./helpers.ts";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listFiles(root, relative)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(relative);
    }
  }
  return out.sort();
}

async function writeAsset(
  workspace: string,
  relativeUnderAssets: string,
  contents: string | Buffer,
): Promise<void> {
  const absolute = join(workspace, "assets", relativeUnderAssets);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, contents);
}

async function setConfigWithAssets(
  workspace: string,
  assets: readonly string[],
  options?: { version?: string },
): Promise<void> {
  await writeWorkspaceFile(
    workspace,
    "explodex.config.ts",
    `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: ${JSON.stringify(options?.version ?? "0.1.0")},
  displayName: "Artifact Fixture",
  description: "asset and dist fixture",
  lifecycle: "dynamic",
  assets: ${JSON.stringify(assets)},
});
`,
  );
}

describe("VAL-SDK-021 declared assets define exact generated asset set", () => {
  test("copies declared text/binary/zero-length/nested assets and excludes undeclared files", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-asset-matrix",
    });
    try {
      await writeAsset(workspace, "readme.txt", "plain text asset\n");
      await writeAsset(workspace, "empty.bin", Buffer.alloc(0));
      await writeAsset(workspace, "nested/deep/icon.bin", Buffer.from([0x00, 0xff, 0x10]));
      await writeAsset(workspace, "notices/NOTICE", "notice body\n");
      await writeAsset(workspace, "undeclared-secret.txt", "LEAK\n");
      await setConfigWithAssets(workspace, [
        "readme.txt",
        "empty.bin",
        "nested/deep/icon.bin",
        "notices/NOTICE",
      ]);

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);

      const distAssets = join(workspace, "dist", "assets");
      expect(await readFile(join(distAssets, "readme.txt"), "utf8")).toBe("plain text asset\n");
      expect((await readFile(join(distAssets, "empty.bin"))).byteLength).toBe(0);
      expect(Buffer.from(await readFile(join(distAssets, "nested/deep/icon.bin"))).equals(
        Buffer.from([0x00, 0xff, 0x10]),
      )).toBe(true);
      expect(await readFile(join(distAssets, "notices/NOTICE"), "utf8")).toBe("notice body\n");
      await expect(access(join(distAssets, "undeclared-secret.txt"))).rejects.toBeDefined();

      const manifest = JSON.parse(
        await readFile(join(workspace, "dist", "plugin.json"), "utf8"),
      ) as { assets: string[] };
      expect(manifest.assets).toEqual([
        "assets/empty.bin",
        "assets/nested/deep/icon.bin",
        "assets/notices/NOTICE",
        "assets/readme.txt",
      ]);
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("missing and unsafe asset declarations fail without committing a new dist", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-bad-assets",
      withDist: true,
    });
    try {
      const prior = await fingerprintDistTree(workspace);
      expect(prior).not.toBeNull();

      await setConfigWithAssets(workspace, ["missing.txt"]);
      const missing = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(missing.ok).toBe(false);
      expect(await fingerprintDistTree(workspace)).toBe(prior);

      await writeAsset(workspace, "ok.txt", "ok\n");
      await setConfigWithAssets(workspace, ["../escape.txt"]);
      const traversal = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(traversal.ok).toBe(false);
      expect(await fingerprintDistTree(workspace)).toBe(prior);

      await setConfigWithAssets(workspace, ["/abs/path.txt"]);
      const absolute = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(absolute.ok).toBe(false);
      expect(await fingerprintDistTree(workspace)).toBe(prior);

      await setConfigWithAssets(workspace, ["nested\\win.txt"]);
      const backslash = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(backslash.ok).toBe(false);
      expect(await fingerprintDistTree(workspace)).toBe(prior);

      await writeAsset(workspace, "link-target.txt", "target\n");
      await symlink(
        join(workspace, "assets", "link-target.txt"),
        join(workspace, "assets", "safe-link.txt"),
      );
      // Escaping symlink should fail.
      await symlink("/etc/hosts", join(workspace, "assets", "escape-link.txt"));
      await setConfigWithAssets(workspace, ["escape-link.txt"]);
      const escapeLink = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(escapeLink.ok).toBe(false);
      expect(await fingerprintDistTree(workspace)).toBe(prior);
    } finally {
      await cleanup();
    }
  }, 180_000);
});

describe("VAL-SDK-023 generated plugin manifest and portable map", () => {
  test("emits exact schemaVersion-1 plugin.json and package-relative map", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-manifest-map",
    });
    try {
      await writeAsset(workspace, "a.txt", "a\n");
      await setConfigWithAssets(workspace, ["a.txt"], { version: "build.1+meta" });
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  setup() {},
});
`,
      );

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);

      const manifestRaw = await readFile(join(workspace, "dist", "plugin.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      expect(Object.keys(manifest).sort()).toEqual(
        [
          "assets",
          "description",
          "displayName",
          "entry",
          "id",
          "lifecycle",
          "schemaVersion",
          "sdkRange",
          "version",
        ].sort(),
      );
      expect(manifest).toEqual({
        schemaVersion: 1,
        id: "manifest-map",
        version: "build.1+meta",
        displayName: "Artifact Fixture",
        description: "asset and dist fixture",
        sdkRange: expect.stringMatching(/^\^?\d/),
        lifecycle: "dynamic",
        entry: "index.js",
        assets: ["assets/a.txt"],
      });

      const js = await readFile(join(workspace, "dist", "index.js"), "utf8");
      expect(js).toContain("sourceMappingURL=index.js.map");
      const map = JSON.parse(await readFile(join(workspace, "dist", "index.js.map"), "utf8")) as {
        version: number;
        file: string;
        sources: string[];
        sourcesContent: string[];
        names: string[];
        mappings: string;
        sourceRoot: string;
      };
      expect(map.version).toBe(3);
      expect(map.file).toBe("index.js");
      expect(map.sourceRoot).toBe("");
      expect(map.sources.length).toBeGreaterThan(0);
      expect(map.sources.every((source) => /^src\/.+\.tsx?$/.test(source))).toBe(true);
      expect(map.sourcesContent.length).toBe(map.sources.length);
      expect(map.sourcesContent.every((source) => typeof source === "string")).toBe(true);
      expect(map.names.every((name) => typeof name === "string")).toBe(true);
      expect(map.mappings.length).toBeGreaterThan(0);
      expect(map.sources.every((source) => !source.startsWith("/") && !source.includes(workspace))).toBe(
        true,
      );
      expect(map.sources.some((source) => source.includes("src/"))).toBe(true);
      expect(JSON.stringify(map)).not.toContain(workspace);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("VAL-SDK-024 atomic complete dist commit or preserve prior", () => {
  test("successful build commits complete installable set and leaves authored sources unchanged", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-atomic-ok",
    });
    try {
      await writeAsset(workspace, "note.txt", "note\n");
      await setConfigWithAssets(workspace, ["note.txt"]);
      const authoredBefore = sha256(await readFile(join(workspace, "src/index.ts")));

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);

      const distFiles = await listFiles(join(workspace, "dist"));
      for (const required of INSTALLABLE_ROOT_FILES) {
        expect(distFiles).toContain(required);
      }
      expect(distFiles).toContain("assets/note.txt");
      expect(distFiles).toContain(GENERATION_FILE);
      expect(sha256(await readFile(join(workspace, "src/index.ts")))).toBe(authoredBefore);

      // No leftover staging directories.
      const rootEntries = await readdir(workspace);
      expect(rootEntries.some((name) => name.includes("staging"))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("bundle failure preserves prior complete dist byte-for-byte", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-atomic-fail",
    });
    try {
      await writeAsset(workspace, "keep.txt", "keep\n");
      await setConfigWithAssets(workspace, ["keep.txt"]);
      const first = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(first.ok).toBe(true);
      const prior = await fingerprintDistTree(workspace);
      expect(prior).not.toBeNull();

      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import { missing } from "./nope";
export default definePlugin({ setup() { void missing; } });
`,
      );
      const failed = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(failed.ok).toBe(false);
      expect(await fingerprintDistTree(workspace)).toBe(prior);
      expect(await readFile(join(workspace, "dist", "assets", "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      await cleanup();
    }
  }, 180_000);
});

describe("VAL-SDK-025 packaging binds dist to intended source generation", () => {
  test("tracks imported workspace modules and rejects stale helper changes", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-generation-helper",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/settings.ts",
        'export const settingValue = "before";\n',
      );
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import { settingValue } from "./settings";
export default definePlugin({
  setup() {
    void settingValue;
  },
});
`,
      );
      const built = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);
      const generation = JSON.parse(
        await readFile(
          join(workspace, "dist", ".explodex-generation.json"),
          "utf8",
        ),
      ) as { inputDigests: Record<string, string> };
      expect(generation.inputDigests["src/settings.ts"]).toMatch(
        /^[a-f0-9]{64}$/,
      );

      await writeWorkspaceFile(
        workspace,
        "src/settings.ts",
        'export const settingValue = "after";\n',
      );
      const outputDir = join(workspace, "..", "out-stale-helper");
      await mkdir(outputDir, { recursive: true });
      const packaged = await packagePluginWorkspace({
        workspacePath: workspace,
        outputDir,
        timeoutMs: 60_000,
      });
      expect(packaged.ok).toBe(false);
      if (packaged.ok) throw new Error("expected stale helper rejection");
      expect(packaged.code).toBe("plugin.package.stale");
      expect(await readdir(outputDir)).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 180_000);

  test("package succeeds for current generation and refuses stale or edited dist", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-generation",
    });
    try {
      await writeAsset(workspace, "x.txt", "x\n");
      await setConfigWithAssets(workspace, ["x.txt"]);
      const built = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);

      const outOk = join(workspace, "..", "out-ok");
      await mkdir(outOk, { recursive: true });
      const packaged = await packagePluginWorkspace({
        workspacePath: workspace,
        outputDir: outOk,
        timeoutMs: 60_000,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) throw new Error(packaged.message);
      expect(packaged.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      const outListing = await readdir(outOk);
      expect(outListing.length).toBeGreaterThan(0);

      // Edit generated output → package refuses and leaves a fresh empty dir untouched.
      const outEdited = join(workspace, "..", "out-edited");
      await mkdir(outEdited, { recursive: true });
      const beforeEdited = await readdir(outEdited);
      await writeFile(join(workspace, "dist", "index.js"), "/* tampered */\n", "utf8");
      const refuseEdited = await packagePluginWorkspace({
        workspacePath: workspace,
        outputDir: outEdited,
        timeoutMs: 60_000,
      });
      expect(refuseEdited.ok).toBe(false);
      expect(await readdir(outEdited)).toEqual(beforeEdited);

      // Rebuild, then change source without rebuild → stale generation refusal.
      const rebuilt = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(rebuilt.ok).toBe(true);
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
export default definePlugin({ setup() { /* changed */ } });
`,
      );
      const outStale = join(workspace, "..", "out-stale");
      await mkdir(outStale, { recursive: true });
      const beforeStale = await readdir(outStale);
      const refuseStale = await packagePluginWorkspace({
        workspacePath: workspace,
        outputDir: outStale,
        timeoutMs: 60_000,
      });
      expect(refuseStale.ok).toBe(false);
      expect(await readdir(outStale)).toEqual(beforeStale);
    } finally {
      await cleanup();
    }
  }, 240_000);

  test("package rejects a changed bundled dependency with the stable payload-mismatch failure", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-generation-dependency",
    });
    try {
      const dependencyRoot = join(workspace, "node_modules", "fixture-dependency");
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(
        join(dependencyRoot, "package.json"),
        `${JSON.stringify({
          name: "fixture-dependency",
          version: "1.0.0",
          type: "module",
          exports: {
            ".": {
              types: "./index.d.ts",
              default: "./index.js",
            },
          },
        }, null, 2)}\n`,
      );
      await writeFile(
        join(dependencyRoot, "index.d.ts"),
        "export declare const dependencyValue: string;\n",
      );
      await writeFile(
        join(dependencyRoot, "index.js"),
        'export const dependencyValue = "before";\n',
      );
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import { dependencyValue } from "fixture-dependency";
export default definePlugin({
  setup() {
    globalThis.document?.body?.setAttribute("data-fixture", dependencyValue);
  },
});
`,
      );

      const built = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);

      await writeFile(
        join(dependencyRoot, "index.js"),
        'export const dependencyValue = "after";\n',
      );
      const outputDir = join(workspace, "..", "out-dependency-mismatch");
      const packaged = await packagePluginWorkspace({
        workspacePath: workspace,
        outputDir,
        timeoutMs: 60_000,
      });
      expect(packaged).toMatchObject({
        ok: false,
        code: "develop.publishable-rebuild-required",
        details: {
          proofCode: "payload-mismatch",
        },
      });
      expect(await access(outputDir).then(() => true).catch(() => false)).toBe(
        false,
      );
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("VAL-SDK-026 pinned inputs reproduce payload bytes and identity", () => {
  test("lexical and canonical aliases of one workspace produce byte-identical installable files", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-repro-alias",
    });
    try {
      const canonicalWorkspace = await realpath(workspace);
      expect(canonicalWorkspace).not.toBe(workspace);

      const lexicalBuild = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(lexicalBuild.ok).toBe(true);
      if (!lexicalBuild.ok) throw new Error(lexicalBuild.message);

      const installable = [
        "index.js",
        "index.js.map",
        "plugin.json",
        "checksums.json",
      ];
      const lexicalHashes = new Map<string, string>();
      for (const relative of installable) {
        lexicalHashes.set(
          relative,
          sha256(await readFile(join(workspace, "dist", relative))),
        );
      }

      const canonicalBuild = await buildPluginWorkspace({
        workspacePath: canonicalWorkspace,
        timeoutMs: 60_000,
      });
      expect(canonicalBuild.ok).toBe(true);
      if (!canonicalBuild.ok) throw new Error(canonicalBuild.message);

      expect(canonicalBuild.payloadSha256).toBe(lexicalBuild.payloadSha256);
      for (const relative of installable) {
        const lexicalHash = lexicalHashes.get(relative);
        if (lexicalHash === undefined) {
          throw new Error(`missing lexical hash for ${relative}`);
        }
        expect(sha256(await readFile(join(workspace, "dist", relative)))).toBe(
          lexicalHash,
        );
      }
      const canonicalJs = await readFile(
        join(workspace, "dist", "index.js"),
        "utf8",
      );
      const canonicalMap = await readFile(
        join(workspace, "dist", "index.js.map"),
        "utf8",
      );
      for (const absolutePath of [workspace, canonicalWorkspace]) {
        expect(canonicalJs).not.toContain(absolutePath);
        expect(canonicalMap).not.toContain(absolutePath);
      }
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("two isolated builds with identical inputs produce byte-identical installable files", async () => {
    // Same package/folder identity in different absolute roots (plugin ID is input).
    const packageName = "explodex-plugin-repro-identical";
    const make = async () => {
      const { workspace, cleanup } = await createValidWorkspace({ name: packageName });
      await writeAsset(workspace, "binary.bin", Buffer.from([1, 2, 3, 4]));
      await writeAsset(workspace, "zero", Buffer.alloc(0));
      await setConfigWithAssets(workspace, ["binary.bin", "zero"], { version: "repro.1" });
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
export default definePlugin({
  setup() {
    return;
  },
});
`,
      );
      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(true);
      return { workspace, cleanup };
    };

    const a = await make();
    const b = await make();
    try {
      expect(a.workspace).not.toBe(b.workspace);
      const installable = [
        "index.js",
        "index.js.map",
        "plugin.json",
        "checksums.json",
        "assets/binary.bin",
        "assets/zero",
      ];
      for (const relative of installable) {
        const left = await readFile(join(a.workspace, "dist", relative));
        const right = await readFile(join(b.workspace, "dist", relative));
        expect(sha256(left)).toBe(sha256(right));
      }

      const checksumsA = await readChecksums(join(a.workspace, "dist"));
      const checksumsB = await readChecksums(join(b.workspace, "dist"));
      expect(checksumsA).toEqual(checksumsB);
      const payloadA = computePayloadSha256(checksumsA);
      const payloadB = computePayloadSha256(checksumsB);
      expect(payloadA).toBe(payloadB);
      expect(payloadA).toMatch(/^[a-f0-9]{64}$/);

      const mapA = await readFile(join(a.workspace, "dist", "index.js.map"), "utf8");
      expect(mapA).not.toContain(a.workspace);
      expect(mapA).not.toContain(b.workspace);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 240_000);
});
