import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import {
  buildChecksumsFromDir,
  computePayloadSha256,
  readChecksums,
  writeChecksums,
} from "../../src/plugin/checksums.ts";
import { listInstallableFiles } from "../../src/plugin/dist-files.ts";
import { buildNamedRootArchive } from "../../src/plugin/archive.ts";
import { ingestLocalPluginArchive } from "../../src/plugin/installer.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function archiveDist(options: {
  workspace: string;
  id: string;
  version: string;
  payloadSha256: string;
  archivePath: string;
}): Promise<void> {
  const entries = [];
  for (const relativePath of await listInstallableFiles(join(options.workspace, "dist"))) {
    entries.push({
      relativePath,
      bytes: await readFile(join(options.workspace, "dist", relativePath)),
    });
  }
  const archive = buildNamedRootArchive({
    id: options.id,
    version: options.version,
    payloadSha256: options.payloadSha256,
    entries,
  });
  await writeFile(options.archivePath, archive.archiveBytes);
}

async function invalidArchiveFixture(name: string) {
  const fixture = await createValidWorkspace({ name });
  await writeWorkspaceFile(
    fixture.workspace,
    "src/index.ts",
    `import { definePlugin } from "@explodex/sdk";
export default definePlugin({ setup() {} });
`,
  );
  const built = await buildPluginWorkspace({
    workspacePath: fixture.workspace,
    timeoutMs: 60_000,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(built.message);
  return { fixture, built };
}

async function stagingEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

describe("VAL-SDK-038 standalone validation failure matrix before commit", () => {
  test("rejects schema, compatibility, browser, definition, and extra-file failures with staging cleanup", async () => {
    const cases: Array<{
      name: string;
      mutate(dist: string): Promise<void>;
      expected: RegExp;
    }> = [
      {
        name: "schema",
        expected: /schemaVersion|unexpected or missing fields/i,
        async mutate(dist) {
          const manifest = JSON.parse(await readFile(join(dist, "plugin.json"), "utf8")) as Record<string, unknown>;
          manifest.schemaVersion = 99;
          await writeFile(join(dist, "plugin.json"), `${JSON.stringify(manifest)}\n`);
          await writeChecksums(dist, await buildChecksumsFromDir(dist));
        },
      },
      {
        name: "compatibility",
        expected: /incompatible/i,
        async mutate(dist) {
          const manifest = JSON.parse(await readFile(join(dist, "plugin.json"), "utf8")) as Record<string, unknown>;
          manifest.sdkRange = ">=999.0.0";
          await writeFile(join(dist, "plugin.json"), `${JSON.stringify(manifest)}\n`);
          await writeChecksums(dist, await buildChecksumsFromDir(dist));
        },
      },
      {
        name: "browser",
        expected: /forbidden|require\(/i,
        async mutate(dist) {
          await writeFile(
            join(dist, "index.js"),
            `require("node:fs");\n//# sourceMappingURL=index.js.map\n`,
          );
          await writeChecksums(dist, await buildChecksumsFromDir(dist));
        },
      },
      {
        name: "definition",
        expected: /definition registration/i,
        async mutate(dist) {
          await writeFile(
            join(dist, "index.js"),
            `(function(){})();\n//# sourceMappingURL=index.js.map\n`,
          );
          await writeChecksums(dist, await buildChecksumsFromDir(dist));
        },
      },
      {
        name: "extra-file",
        expected: /Declared assets|Unexpected|checksums/i,
        async mutate(dist) {
          await writeFile(join(dist, "assets", "undeclared.txt"), "extra");
          await writeChecksums(dist, await buildChecksumsFromDir(dist));
        },
      },
    ];

    for (const fixtureCase of cases) {
      const { fixture, built } = await invalidArchiveFixture(
        `explodex-plugin-invalid-${fixtureCase.name}`,
      );
      try {
        const dist = join(fixture.workspace, "dist");
        await mkdir(join(dist, "assets"), { recursive: true });
        await fixtureCase.mutate(dist);
        const archivePath = join(fixture.root, `${fixtureCase.name}.tar.gz`);
        await archiveDist({
          workspace: fixture.workspace,
          id: built.report.id,
          version: built.report.version,
          payloadSha256: computePayloadSha256(await readChecksums(dist)),
          archivePath,
        });
        const stagingParent = join(fixture.root, "staging");
        const result = await ingestLocalPluginArchive({
          archivePath,
          stagingParent,
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected validation failure");
        expect(result.message).toMatch(fixtureCase.expected);
        expect(await stagingEntries(stagingParent)).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    }
  }, 300_000);
});
