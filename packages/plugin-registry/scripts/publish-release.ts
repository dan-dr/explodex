import { prepareReleasePublication } from "../src/release-publication.ts";

type Arguments = {
  stagingDirectory: string;
  releaseTag: string;
  approval: string;
};

function usage(): string {
  return "Usage: bun scripts/publish-release.ts --staging-dir <directory> --release-tag <tag> --approval <registry-sha256>";
}

function parseArguments(values: readonly string[]): Arguments {
  let stagingDirectory: string | undefined;
  let releaseTag: string | undefined;
  let approval: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (value === undefined) throw new Error(`${usage()}\nMissing value for ${key ?? "argument"}.`);
    if (key === "--staging-dir") stagingDirectory = value;
    else if (key === "--release-tag") releaseTag = value;
    else if (key === "--approval") approval = value;
    else throw new Error(`${usage()}\nInvalid argument: ${key ?? ""}`);
    index += 1;
  }
  if (stagingDirectory === undefined || releaseTag === undefined || approval === undefined) {
    throw new Error(`${usage()}\n--staging-dir, --release-tag, and --approval are required.`);
  }
  return { stagingDirectory, releaseTag, approval };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const plan = await prepareReleasePublication(parsed);
  if (!plan.ok) throw new Error(`${plan.code}: ${plan.message}`);
  const processHandle = Bun.spawn([...plan.command], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

await main();
