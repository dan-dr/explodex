#!/usr/bin/env bun
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: [join(root, "scripts", "cdp-inject.ts")],
  outdir: join(root, "lib"),
  naming: "cdp-inject.mjs",
  target: "node",
  format: "esm",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const cliBuild = Bun.spawn(["bun", "run", "build"], {
  cwd: join(root, "packages", "cli"),
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const cliExitCode = await cliBuild.exited;
if (cliExitCode !== 0) process.exit(cliExitCode);
