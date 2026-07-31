#!/usr/bin/env bun
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bunBinary = process.env.HOME
  ? join(process.env.HOME, ".bun", "bin", "bun")
  : "bun";

for (const packageName of ["sdk", "cli"] as const) {
  const packageRoot = join(root, "packages", packageName);
  const packageBuild = Bun.spawn(["bash", "./scripts/run-build.sh"], {
    cwd: packageRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PATH: `${join(process.env.HOME ?? "", ".bun", "bin")}:${process.env.PATH ?? ""}`,
      // Ensure nested package builds resolve the official Bun install.
      EXPLODEX_BUN: bunBinary,
    },
  });
  const packageExitCode = await packageBuild.exited;
  if (packageExitCode !== 0) process.exit(packageExitCode);
}
