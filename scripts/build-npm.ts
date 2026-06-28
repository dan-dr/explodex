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
