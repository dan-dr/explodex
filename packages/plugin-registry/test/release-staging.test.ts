import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FIRST_PARTY_PLUGIN_IDS, type ValidatedArchive } from "../src/registry-generation.ts";
import { stageRegistryRelease } from "../src/release-staging.ts";

const PAYLOAD = "a".repeat(64);

function validated(id: string, archiveSha256: string): ValidatedArchive {
  return {
    ok: true,
    id,
    version: "1.0.0",
    displayName: `${id} display`,
    description: `${id} description`,
    lifecycle: "dynamic",
    sdkRange: "^1.2.0",
    payloadSha256: PAYLOAD,
    archiveSha256,
    source: "archive",
  };
}

async function fixtureArtifacts(): Promise<{
  root: string;
  paths: string[];
  validator: (path: string) => Promise<ValidatedArchive>;
}> {
  const root = await mkdtemp(join(tmpdir(), "explodex-release-stage-test-"));
  const archives = new Map<string, ValidatedArchive>();
  const paths: string[] = [];
  for (const [index, id] of FIRST_PARTY_PLUGIN_IDS.entries()) {
    const archiveSha256 = String(index).repeat(64);
    const path = join(root, `${id}-1.0.0-${PAYLOAD}.tar.gz`);
    await writeFile(path, `${id}-archive`);
    archives.set(basename(path), validated(id, archiveSha256));
    paths.push(path);
  }
  return {
    root,
    paths,
    validator: async (path) => archives.get(basename(path))!,
  };
}

describe("release staging", () => {
  test("atomically stages exactly registry.json and seven validated archives", async () => {
    const fixture = await fixtureArtifacts();
    const outputDirectory = join(fixture.root, "release");
    const staged = await stageRegistryRelease({
      artifactPaths: [...fixture.paths].reverse(),
      outputDirectory,
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: fixture.validator,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error(staged.message);
    expect(staged.files).toHaveLength(8);
    expect(staged.files).toContain("registry.json");
    expect((await readdir(outputDirectory)).sort()).toEqual([...staged.files].sort());
    const registryText = await readFile(join(outputDirectory, "registry.json"), "utf8");
    expect(staged.registrySha256).toHaveLength(64);
    expect(registryText.endsWith("\n")).toBe(true);
  });

  test("refuses to overwrite a non-empty output directory", async () => {
    const fixture = await fixtureArtifacts();
    const outputDirectory = join(fixture.root, "release");
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, "existing.txt"), "keep");
    const staged = await stageRegistryRelease({
      artifactPaths: fixture.paths,
      outputDirectory,
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: fixture.validator,
    });
    expect(staged).toMatchObject({ ok: false, code: "registry.staging-output" });
    expect(await readFile(join(outputDirectory, "existing.txt"), "utf8")).toBe("keep");
  });
});
