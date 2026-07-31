import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..", "..", "..");

describe("release documentation approval binding", () => {
  test("publishes approved tarballs only after immutable-tag verification", async () => {
    const docs = await readFile(join(repositoryRoot, "docs", "RELEASING.md"), "utf8");
    const ciWorkflow = await readFile(
      join(repositoryRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const workflowDispatch = docs.indexOf("gh workflow run release.yml");
    const npmSection = docs.indexOf("## 6. Publish npm");

    expect(workflowDispatch).toBeGreaterThan(0);
    expect(workflowDispatch).toBeLessThan(npmSection);
    expect(docs).toContain("npm publish /absolute/path/to/reviewed/explodex-sdk-X.Y.Z.tgz");
    expect(docs).toContain("npm publish /absolute/path/to/reviewed/explodex-X.Y.Z.tgz");
    expect(docs).not.toContain("npm publish ./packages/sdk");
    expect(docs).not.toContain("npm publish ./packages/cli");
    expect(docs).toContain("git push origin <release-branch>");
    expect(docs).not.toContain("git push origin main");
    expect(ciWorkflow).toContain('- "codex/**"');
  });
});
