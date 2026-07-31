import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stageRegistryRelease } from "../src/release-staging.ts";

type Arguments = {
  artifactDirectory: string;
  outputDirectory: string;
  repository: string;
  releaseTag: string;
};

function usage(): string {
  return "Usage: bun scripts/stage-release.ts --artifact-dir <directory> --output-dir <empty-directory> --release-tag <tag> [--repository <owner/repo>]";
}

function parseArguments(values: readonly string[]): Arguments {
  let artifactDirectory: string | undefined;
  let outputDirectory: string | undefined;
  let releaseTag: string | undefined;
  let repository = "dan-dr/explodex";
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (value === undefined) throw new Error(`${usage()}\nMissing value for ${key ?? "argument"}.`);
    if (key === "--artifact-dir") artifactDirectory = resolve(value);
    else if (key === "--output-dir") outputDirectory = resolve(value);
    else if (key === "--release-tag") releaseTag = value;
    else if (key === "--repository") repository = value;
    else throw new Error(`${usage()}\nInvalid argument: ${key ?? ""}`);
    index += 1;
  }
  if (artifactDirectory === undefined || outputDirectory === undefined || releaseTag === undefined) {
    throw new Error(`${usage()}\n--artifact-dir, --output-dir, and --release-tag are required.`);
  }
  return { artifactDirectory, outputDirectory, repository, releaseTag };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const artifactPaths = (await readdir(parsed.artifactDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tar.gz"))
    .map((entry) => join(parsed.artifactDirectory, entry.name));
  const staged = await stageRegistryRelease({
    artifactPaths,
    outputDirectory: parsed.outputDirectory,
    repository: parsed.repository,
    releaseTag: parsed.releaseTag,
  });
  if (!staged.ok) throw new Error(`${staged.code}: ${staged.message}`);
  process.stdout.write(`${JSON.stringify({ outputDirectory: staged.outputPath, registrySha256: staged.registrySha256 })}\n`);
}

await main();
