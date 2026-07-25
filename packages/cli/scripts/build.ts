#!/usr/bin/env bun
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const stagingRoot = join(packageRoot, "dist-build");
const finalRoot = join(packageRoot, "dist");
const tsc = join(repositoryRoot, "node_modules", ".bin", "tsc");

await rm(stagingRoot, { recursive: true, force: true });

const compilation = Bun.spawn([tsc, "-p", join(packageRoot, "tsconfig.build.json")], {
  cwd: packageRoot,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await compilation.exited;
if (exitCode !== 0) process.exit(exitCode);

const sourceHelper = join(packageRoot, "src", "runtime", "bin", "explodex-runtime-helper");
const targetHelperDirectory = join(stagingRoot, "runtime", "bin");
const targetHelper = join(targetHelperDirectory, "explodex-runtime-helper");
await mkdir(targetHelperDirectory, { recursive: true });
await copyFile(sourceHelper, targetHelper);
await chmod(targetHelper, 0o755);

await rm(finalRoot, { recursive: true, force: true });
await rename(stagingRoot, finalRoot);
