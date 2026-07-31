import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateRegistry, writeGeneratedRegistry } from "../src/registry-generation.ts";

type ParsedArguments = {
  artifacts: string[];
  artifactDirectory: string | null;
  outputPath: string;
  repository: string;
  releaseTag: string;
};

function usage(): string {
  return "Usage: bun scripts/generate-registry.ts (--artifact <archive.tar.gz> [... ] | --artifact-dir <directory>) --release-tag <tag> [--repository <owner/repo>] [--output <registry.json>]";
}

function parseArguments(argumentsList: readonly string[]): ParsedArguments {
  const artifacts: string[] = [];
  let artifactDirectory: string | null = null;
  let outputPath = "release-staging/registry.json";
  let repository = "dan-dr/explodex";
  let releaseTag: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (argument === "--artifact" && value !== undefined) {
      artifacts.push(value);
      index += 1;
      continue;
    }
    if (argument === "--output" && value !== undefined) {
      outputPath = value;
      index += 1;
      continue;
    }
    if (argument === "--artifact-dir" && value !== undefined) {
      artifactDirectory = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--repository" && value !== undefined) {
      repository = value;
      index += 1;
      continue;
    }
    if (argument === "--release-tag" && value !== undefined) {
      releaseTag = value;
      index += 1;
      continue;
    }
    throw new Error(`${usage()}\nInvalid argument: ${argument ?? ""}`);
  }
  if (releaseTag === undefined) throw new Error(`${usage()}\n--release-tag is required.`);
  if (artifactDirectory !== null && artifacts.length > 0) {
    throw new Error(`${usage()}\nUse --artifact or --artifact-dir, not both.`);
  }
  return { artifacts, artifactDirectory, outputPath: resolve(outputPath), repository, releaseTag };
}

async function artifactPaths(parsed: ParsedArguments): Promise<string[]> {
  if (parsed.artifactDirectory === null) return parsed.artifacts;
  return (await readdir(parsed.artifactDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tar.gz"))
    .map((entry) => join(parsed.artifactDirectory!, entry.name))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const generated = await generateRegistry({
    artifactPaths: await artifactPaths(parsed),
    repository: parsed.repository,
    releaseTag: parsed.releaseTag,
  });
  if (!generated.ok) {
    throw new Error(`${generated.code}: ${generated.message}`);
  }
  await writeGeneratedRegistry({ outputPath: parsed.outputPath, generation: generated });
  process.stdout.write(`${parsed.outputPath}\n`);
}

await main();
