#!/usr/bin/env bun
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const skillRoot = join(root, "skills", "explodex-plugin-builder");
const check = process.argv.includes("--check");

const files = [
  {
    source: join(root, "docs", "sdk-api.md"),
    target: join(skillRoot, "references", "sdk-api.md"),
    transform(content: string) {
      const repoUrl = "https://github.com/dan-dr/explodex/blob/main";
      const note = "> Bundled SDK snapshot for standalone plugin authoring. Repo-only paths and commands in examples are optional; follow [standalone.md](standalone.md) when no checkout is available.\n\n";
      return content
        .replace("# Explodex SDK API Reference\n\n", `# Explodex SDK API Reference\n\n${note}`)
        .replaceAll("(../AGENTS.md", `(${repoUrl}/AGENTS.md`);
    },
  },
];

let stale = false;
for (const file of files) {
  const expected = file.transform(await Bun.file(file.source).text());
  if (check) {
    const actualFile = Bun.file(file.target);
    const actual = await actualFile.exists() ? await actualFile.text() : null;
    if (actual !== expected) {
      console.error(`Stale skill snapshot: ${file.target}`);
      stale = true;
    }
    continue;
  }
  await Bun.write(file.target, expected);
  console.log(`Synced ${file.target}`);
}

if (stale) {
  console.error("Run: bun scripts/sync-plugin-skill.ts");
  process.exit(1);
}
