import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateInstallablePayloadDir,
} from "../../src/plugin/artifact-validate.ts";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import {
  buildChecksumsFromDir,
  computePayloadSha256,
  parseChecksumsJson,
  writeChecksums,
  type ChecksumsManifest,
} from "../../src/plugin/checksums.ts";
import {
  comparePayloadPathsByUtf8Bytes,
  PayloadPathTopologyTracker,
  validateNormalizedPayloadPath,
} from "../../src/plugin/payload-path.ts";
import { encodeArtifactIdentity } from "../../src/plugin/identity-encode.ts";
import { validatePluginSourceMapV3 } from "../../src/plugin/source-map.ts";
import {
  createValidWorkspace,
  writeWorkspaceFile,
} from "./helpers.ts";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function independentPayloadSha256(manifest: ChecksumsManifest): string {
  const paths = Object.keys(manifest.files).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  const chunks: Buffer[] = [Buffer.from("explodex-payload-v1\0", "utf8")];
  for (const path of paths) {
    const record = manifest.files[path]!;
    chunks.push(
      Buffer.from(path, "utf8"),
      Buffer.from("\0", "utf8"),
      Buffer.from(String(record.bytes), "utf8"),
      Buffer.from("\0", "utf8"),
      Buffer.from(record.sha256, "utf8"),
      Buffer.from("\n", "utf8"),
    );
  }
  return sha256(Buffer.concat(chunks));
}

function validSourceMap(): Record<string, unknown> {
  return {
    version: 3,
    file: "index.js",
    sourceRoot: "",
    sources: ["src/index.ts"],
    sourcesContent: ['export default "fixture";\n'],
    names: [],
    mappings: "AAAA",
  };
}

describe("M2-F07R canonical payload path authority", () => {
  test("sorts paths by encoded UTF-8 bytes for checksum serialization and payload identity", () => {
    const astral = "assets/\u{10000}.txt";
    const bmp = "assets/\uE000.txt";
    expect([astral, bmp].sort()).toEqual([astral, bmp]);
    expect([astral, bmp].sort(comparePayloadPathsByUtf8Bytes)).toEqual([bmp, astral]);

    const manifest: ChecksumsManifest = {
      schemaVersion: 1,
      files: {
        [astral]: { sha256: "a".repeat(64), bytes: 1 },
        [bmp]: { sha256: "b".repeat(64), bytes: 2 },
      },
    };
    expect(computePayloadSha256(manifest)).toBe(independentPayloadSha256(manifest));
  });

  test("rejects every C0 control and DEL plus traversal and aliases through one authority", () => {
    for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 0x7f]) {
      const raw = `assets/a${String.fromCharCode(codePoint)}b`;
      const result = validateNormalizedPayloadPath(raw, { kind: "file" });
      expect(result.ok).toBe(false);
      expect(() =>
        computePayloadSha256({
          schemaVersion: 1,
          files: {
            [raw]: { sha256: "a".repeat(64), bytes: 0 },
          },
        })
      ).toThrow(/control character/i);
    }

    for (const raw of [
      "",
      "/absolute",
      "C:/drive",
      "assets\\backslash.txt",
      "assets//empty.txt",
      "assets/./dot.txt",
      "assets/../traversal.txt",
      "assets/trailing/",
      "assets/cafe\u0301.txt",
    ]) {
      expect(validateNormalizedPayloadPath(raw, { kind: "file" }).ok).toBe(false);
    }

    const topology = new PayloadPathTopologyTracker();
    const upper = validateNormalizedPayloadPath("assets/Icon.png", { kind: "file" });
    const lower = validateNormalizedPayloadPath("assets/icon.png", { kind: "file" });
    expect(upper.ok && lower.ok).toBe(true);
    if (!upper.ok || !lower.ok) throw new Error("expected valid paths");
    expect(topology.add(upper.validated, "file")).toBeNull();
    expect(topology.add(lower.validated, "file")?.entryClass).toBe("normalized-collision");
  });

  test("rejects duplicate decoded checksum keys before object construction", () => {
    const record = '{"sha256":"' + "a".repeat(64) + '","bytes":1}';
    const raw = `{"schemaVersion":1,"files":{"assets/a":${record},"assets/\\u0061":${record}}}`;
    expect(() => parseChecksumsJson(raw)).toThrow(/duplicate decoded key.*assets\/a/i);

    const protoAlias =
      `{"schemaVersion":1,"files":{"__proto__":${record},"\\u005f_proto__":${record}}}`;
    expect(() => parseChecksumsJson(protoAlias)).toThrow(
      /duplicate decoded key.*__proto__/i,
    );

    const singleProto = parseChecksumsJson(
      `{"schemaVersion":1,"files":{"__proto__":${record}}}`,
    );
    expect(Object.prototype.hasOwnProperty.call(singleProto.files, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(singleProto.files)).toBeNull();
  });
});

describe("M2-F07R injective artifact identity naming", () => {
  test("all payload digest bytes participate in archive and installed names", () => {
    const prefix = "0123456789ab";
    const firstDigest = `${prefix}${"1".repeat(52)}`;
    const secondDigest = `${prefix}${"2".repeat(52)}`;
    const first = encodeArtifactIdentity({
      id: "identity",
      version: "same-version",
      payloadSha256: firstDigest,
    });
    const second = encodeArtifactIdentity({
      id: "identity",
      version: "same-version",
      payloadSha256: secondDigest,
    });

    expect(first.archiveRootName).toContain(firstDigest);
    expect(first.archiveFileName).toContain(firstDigest);
    expect(first.installedDirectoryName).toContain(firstDigest);
    expect(second.archiveRootName).toContain(secondDigest);
    expect(first.archiveRootName).not.toBe(second.archiveRootName);
    expect(first.archiveFileName).not.toBe(second.archiveFileName);
    expect(first.installedDirectoryName).not.toBe(second.installedDirectoryName);
  });
});

describe("M2-F07R exact V3 source-map authority", () => {
  test("accepts only exact package-relative TypeScript maps with meaningful mappings", () => {
    const generatedSource = "(function(){})();\n//# sourceMappingURL=index.js.map\n";
    expect(validatePluginSourceMapV3({
      mapText: `${JSON.stringify(validSourceMap())}\n`,
      generatedSource,
    }).ok).toBe(true);

    const invalidMaps: Array<Record<string, unknown>> = [
      { ...validSourceMap(), version: 2 },
      { ...validSourceMap(), file: "other.js" },
      { ...validSourceMap(), sourceRoot: "src" },
      { ...validSourceMap(), sources: [] },
      { ...validSourceMap(), sources: ["index.js"] },
      { ...validSourceMap(), sources: ["/tmp/src/index.ts"] },
      { ...validSourceMap(), sources: ["src/../index.ts"] },
      { ...validSourceMap(), sourcesContent: [] },
      { ...validSourceMap(), names: [1] },
      { ...validSourceMap(), mappings: "" },
      { ...validSourceMap(), mappings: ";" },
    ];
    for (const map of invalidMaps) {
      expect(validatePluginSourceMapV3({
        mapText: JSON.stringify(map),
        generatedSource,
      }).ok).toBe(false);
    }

    expect(validatePluginSourceMapV3({
      mapText: JSON.stringify(validSourceMap()),
      generatedSource: "(function(){})();\n//# sourceMappingURL=wrong.map\n",
    }).ok).toBe(false);

    expect(validatePluginSourceMapV3({
      mapText: JSON.stringify(validSourceMap()),
      generatedSource:
        'console.log("//# sourceMappingURL=literal");\n//# sourceMappingURL=index.js.map\n',
    }).ok).toBe(true);
  });

  test("standalone validation rejects map and manifest path tampering after checksums are recomputed", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-authority-repair",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
export default definePlugin({ setup() {} });
`,
      );
      const built = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error(built.message);
      const dist = join(workspace, "dist");

      const originalMap = await readFile(join(dist, "index.js.map"), "utf8");
      const originalManifest = await readFile(join(dist, "plugin.json"), "utf8");
      await mkdir(join(dist, "assets"), { recursive: true });
      const controlledPath = join(dist, "assets", "tab\tname.txt");
      await writeFile(controlledPath, "unsafe", "utf8");
      const badDirectoryPath = await validateInstallablePayloadDir(dist, {
        source: "directory",
      });
      expect(badDirectoryPath.ok).toBe(false);
      if (badDirectoryPath.ok) throw new Error("expected directory path failure");
      expect(badDirectoryPath.message).toMatch(/control character/i);
      await rm(join(dist, "assets"), { recursive: true });

      const tamperedMap = JSON.parse(originalMap) as Record<string, unknown>;
      tamperedMap.mappings = "";
      await writeFile(join(dist, "index.js.map"), `${JSON.stringify(tamperedMap)}\n`, "utf8");
      await writeChecksums(dist, await buildChecksumsFromDir(dist));
      const badMap = await validateInstallablePayloadDir(dist, { source: "directory" });
      expect(badMap.ok).toBe(false);
      if (badMap.ok) throw new Error("expected map failure");
      expect(badMap.message).toMatch(/source map|mappings/i);

      await writeFile(join(dist, "index.js.map"), originalMap, "utf8");
      const manifest = JSON.parse(
        await readFile(join(dist, "plugin.json"), "utf8"),
      ) as Record<string, unknown>;
      manifest.assets = ["assets/tab\tname.txt"];
      await writeFile(join(dist, "plugin.json"), `${JSON.stringify(manifest)}\n`, "utf8");
      await writeChecksums(dist, await buildChecksumsFromDir(dist));
      const badManifestPath = await validateInstallablePayloadDir(dist, { source: "directory" });
      expect(badManifestPath.ok).toBe(false);
      if (badManifestPath.ok) throw new Error("expected manifest path failure");
      expect(badManifestPath.message).toMatch(/asset|control character/i);

      await writeFile(join(dist, "plugin.json"), originalManifest, "utf8");
      const record = '{"sha256":"' + "a".repeat(64) + '","bytes":1}';
      await writeFile(
        join(dist, "checksums.json"),
        `{"schemaVersion":1,"files":{"assets/a":${record},"assets/\\u0061":${record}}}`,
        "utf8",
      );
      const duplicateChecksumKey = await validateInstallablePayloadDir(dist, {
        source: "directory",
      });
      expect(duplicateChecksumKey.ok).toBe(false);
      if (duplicateChecksumKey.ok) throw new Error("expected duplicate checksum failure");
      expect(duplicateChecksumKey.message).toMatch(/duplicate decoded key.*assets\/a/i);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
