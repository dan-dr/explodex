import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_PARTY_PLUGIN_IDS,
  generateRegistry,
  writeGeneratedRegistry,
  type RegistryPluginEntry,
} from "../src/registry-generation.ts";

const DIGEST = "a".repeat(64);

function artifact(id: string, archiveSha256 = DIGEST): {
  ok: true;
  id: string;
  version: string;
  displayName: string;
  description: string;
  lifecycle: "dynamic";
  sdkRange: string;
  payloadSha256: string;
  archiveSha256: string;
  source: "archive";
} {
  return {
    ok: true,
    id,
    version: "1.0.0",
    displayName: `${id} display`,
    description: `${id} description`,
    lifecycle: "dynamic",
    sdkRange: "^1.2.0",
    payloadSha256: DIGEST,
    archiveSha256,
    source: "archive",
  };
}

async function inputPaths(ids: readonly string[]): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "explodex-registry-test-"));
  const paths = ids.map((id) => join(root, `${id}-1.0.0-${DIGEST}.tar.gz`));
  await Promise.all(paths.map((path) => writeFile(path, "fixture")));
  return paths;
}

describe("registry generation", () => {
  test("requires the exact seven first-party plugin IDs by default", async () => {
    const paths = await inputPaths([...FIRST_PARTY_PLUGIN_IDS].reverse());
    const byPath = new Map(
      paths.map((path) => {
        const id = path.slice(path.lastIndexOf("/") + 1).split("-1.0.0-")[0]!;
        return [path, artifact(id)];
      }),
    );
    const generated = await generateRegistry({
      artifactPaths: paths,
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: async (path) => byPath.get(path)!,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error("expected generated registry");
    expect(Object.keys(generated.registry.plugins)).toEqual([...FIRST_PARTY_PLUGIN_IDS]);
  });

  test("creates fixed-key, byte-stable registry JSON from validated archives", async () => {
    const ids = ["alpha", "beta"];
    const paths = await inputPaths(["beta", "alpha"]);
    const byPath = new Map([
      [paths[0]!, artifact("beta", "b".repeat(64))],
      [paths[1]!, artifact("alpha", "c".repeat(64))],
    ]);
    const validator = async (path: string) => byPath.get(path)!;
    const first = await generateRegistry({
      artifactPaths: paths,
      expectedPluginIds: ids,
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: validator,
    });
    const second = await generateRegistry({
      artifactPaths: [...paths].reverse(),
      expectedPluginIds: ids,
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: validator,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected generated registry");
    expect(first.text).toBe(second.text);
    expect(first.text.endsWith("\n")).toBe(true);
    expect(Object.keys(first.registry)).toEqual(["schemaVersion", "repositoryUrl", "plugins"]);
    expect(Object.keys(first.registry.plugins.alpha!)).toEqual([
      "version",
      "displayName",
      "description",
      "sdkRange",
      "artifactUrl",
      "payloadSha256",
      "archiveSha256",
    ] satisfies Array<keyof RegistryPluginEntry>);
    expect(Object.keys(first.registry.plugins)).toEqual(["alpha", "beta"]);
    expect(first.registry.repositoryUrl).toBe("https://github.com/dan-dr/explodex");
    expect(first.registry.plugins.alpha!.artifactUrl).toBe(
      `https://github.com/dan-dr/explodex/releases/download/plugins-v1/alpha-1.0.0-${DIGEST}.tar.gz`,
    );
  });

  test("rejects invalid, duplicate, incomplete, and noncanonical inputs before output replacement", async () => {
    const paths = await inputPaths(["alpha", "beta"]);
    const outputPath = join(tmpdir(), `explodex-registry-${Date.now()}.json`);
    await writeFile(outputPath, "existing\n");
    const invalid = await generateRegistry({
      artifactPaths: paths,
      expectedPluginIds: ["alpha", "beta"],
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: async (path) => path === paths[0]!
        ? { ok: false, code: "plugin.artifact.invalid", message: "bad artifact" }
        : artifact("beta"),
    });
    expect(invalid).toMatchObject({ ok: false, code: "registry.invalid-artifact" });
    expect(await readFile(outputPath, "utf8")).toBe("existing\n");
    const duplicate = await generateRegistry({
      artifactPaths: paths,
      expectedPluginIds: ["alpha", "beta"],
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: async () => artifact("alpha"),
    });
    expect(duplicate).toMatchObject({ ok: false, code: "registry.duplicate-plugin-id" });
    const incomplete = await generateRegistry({
      artifactPaths: [paths[0]!],
      expectedPluginIds: ["alpha", "beta"],
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: async () => artifact("alpha"),
    });
    expect(incomplete).toMatchObject({ ok: false, code: "registry.incomplete" });
    const noncanonical = await generateRegistry({
      artifactPaths: [paths[0]!.replace(/\.tar\.gz$/u, ".tgz"), paths[1]!],
      expectedPluginIds: ["alpha", "beta"],
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: async () => artifact("alpha"),
    });
    expect(noncanonical).toMatchObject({ ok: false, code: "registry.noncanonical-artifact" });
  });

  test("writes only a completed generation atomically", async () => {
    const paths = await inputPaths(["alpha"]);
    const generated = await generateRegistry({
      artifactPaths: paths,
      expectedPluginIds: ["alpha"],
      repository: "dan-dr/explodex",
      releaseTag: "plugins-v1",
      validateArtifact: async () => artifact("alpha"),
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error("expected generated registry");
    const outputPath = join(await mkdtemp(join(tmpdir(), "explodex-registry-output-")), "registry.json");
    await writeGeneratedRegistry({ outputPath, generation: generated });
    expect(await readFile(outputPath, "utf8")).toBe(generated.text);
  });
});
