import { describe, expect, test } from "bun:test";
import { prepareReleasePublication } from "../src/release-publication.ts";

const registrySha256 = "ab".repeat(32);

const verify = async () => ({
  ok: true as const,
  outputPath: "/tmp/explodex-release",
  registrySha256,
  files: ["alpha.tar.gz", "registry.json"],
});

describe("release publication approval gate", () => {
  test("refuses publication when approval does not bind the staged registry", async () => {
    const result = await prepareReleasePublication({
      stagingDirectory: "/tmp/explodex-release",
      releaseTag: "v1.0.0",
      approval: "00".repeat(32),
      verify,
    });
    expect(result).toEqual({
      ok: false,
      code: "registry.publication-not-approved",
      message: "Approval must exactly match the staged registry.json SHA-256.",
    });
  });

  test("prepares a tag-verifying gh command only for the exact approved bytes", async () => {
    const result = await prepareReleasePublication({
      stagingDirectory: "/tmp/explodex-release",
      releaseTag: "v1.0.0",
      approval: registrySha256,
      verify,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.registrySha256).toBe(registrySha256);
    expect(result.command.slice(0, 4)).toEqual(["gh", "release", "create", "v1.0.0"]);
    expect(result.command).toContain("--verify-tag");
    expect(result.command).toContain("--generate-notes");
  });
});
