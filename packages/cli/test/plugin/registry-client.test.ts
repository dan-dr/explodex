import { describe, expect, test } from "bun:test";
import {
  parseCanonicalGitHubArtifactUrl,
  parsePluginRegistry,
  RegistryClientError,
} from "../../src/plugin/registry-client.ts";

const payloadSha256 = "11".repeat(32);
const archiveSha256 = "22".repeat(32);
const artifactUrl =
  `https://github.com/dan-dr/explodex/releases/download/v1.0.0/alpha-1.0.0-${payloadSha256}.tar.gz`;

function validRegistry(): unknown {
  return {
    schemaVersion: 1,
    repositoryUrl: "https://github.com/dan-dr/explodex",
    plugins: {
      alpha: {
        version: "1.0.0",
        displayName: "Alpha",
        description: "Fixture plugin",
        sdkRange: "^1.2.0",
        artifactUrl,
        payloadSha256,
        archiveSha256,
      },
    },
  };
}

describe("plugin registry trust boundary", () => {
  test("parses the exact schema and canonical immutable artifact identity", () => {
    const registry = parsePluginRegistry(validRegistry());
    expect(registry.schemaVersion).toBe(1);
    expect(Object.keys(registry.plugins)).toEqual(["alpha"]);
    expect(registry.plugins.alpha).toEqual({
      version: "1.0.0",
      displayName: "Alpha",
      description: "Fixture plugin",
      sdkRange: "^1.2.0",
      artifactUrl,
      payloadSha256,
      archiveSha256,
    });
    expect(parseCanonicalGitHubArtifactUrl(artifactUrl)).toEqual({
      repositoryUrl: "https://github.com/dan-dr/explodex",
      artifactUrl,
      tag: "v1.0.0",
      assetName: `alpha-1.0.0-${payloadSha256}.tar.gz`,
    });
  });

  test("rejects cross-repository and noncanonical artifact URLs", () => {
    for (const value of [
      artifactUrl.replace("dan-dr/explodex", "attacker/explodex"),
      artifactUrl.replace("https://", "http://"),
      "https://github.com/dan-dr/explodex/archive/refs/heads/main.tar.gz",
    ]) {
      expect(() => parseCanonicalGitHubArtifactUrl(value)).toThrow(RegistryClientError);
    }
  });

  test("rejects extra fields and filename-to-payload identity drift", () => {
    const extra = validRegistry() as {
      plugins: Record<string, Record<string, unknown>>;
    };
    extra.plugins.alpha!.permissions = [];
    expect(() => parsePluginRegistry(extra)).toThrow(RegistryClientError);

    const drift = validRegistry() as {
      plugins: Record<string, Record<string, unknown>>;
    };
    drift.plugins.alpha!.payloadSha256 = "33".repeat(32);
    expect(() => parsePluginRegistry(drift)).toThrow(RegistryClientError);
  });
});
