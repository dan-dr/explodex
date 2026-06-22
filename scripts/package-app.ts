#!/usr/bin/env bun
/**
 * Build dist/Explodex.app from templates/explodex-app + current SDK/plugins.
 * Local dev script — Bun TypeScript. Bundled app contents stay shell-only.
 */

import { access, chmod, cp, constants, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

const ROOT = join(import.meta.dir, "..");
const TEMPLATE = join(ROOT, "templates", "explodex-app");
const DIST = join(ROOT, "dist", "Explodex.app");
const RES = join(DIST, "Contents", "Resources");
const PLUGINS_SRC = join(ROOT, "plugins");
const PLUGINS_DST = join(RES, "plugins");
const ICON_SRC = join(ROOT, "assets", "icon", "Explodex.icns");

export type PackageOptions = {
  /** Omit repo project-root marker (for /Applications installs). */
  release?: boolean;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string[], cwd = ROOT): Promise<void> {
  const proc = spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed with exit code ${code}`);
}

export async function packageApp(options: PackageOptions = {}): Promise<string> {
  const release = options.release === true;
  if (!(await pathExists(TEMPLATE))) {
    throw new Error(`Missing app template at ${TEMPLATE}`);
  }

  await rm(DIST, { recursive: true, force: true });
  await cp(TEMPLATE, DIST, { recursive: true });

  await rm(PLUGINS_DST, { recursive: true, force: true });
  await mkdir(PLUGINS_DST, { recursive: true });

  for (const entry of await readdir(PLUGINS_SRC)) {
    await cp(join(PLUGINS_SRC, entry), join(PLUGINS_DST, entry), { recursive: true });
  }

  await cp(join(ROOT, "sdk", "explodex-sdk.js"), join(RES, "explodex-sdk.js"));
  await cp(join(ROOT, "scripts", "cdp-inject.sh"), join(RES, "cdp-inject.sh"));

  await chmod(join(RES, "cdp-inject.sh"), 0o755);
  await chmod(join(RES, "relaunch.sh"), 0o755);
  await chmod(join(DIST, "Contents", "MacOS", "Explodex"), 0o755);

  await run([
    "bun",
    "build",
    "--compile",
    join(ROOT, "scripts", "cdp-inject.ts"),
    "--outfile",
    join(RES, "cdp-inject-bin"),
  ]);

  await chmod(join(RES, "cdp-inject-bin"), 0o755);

  if (await pathExists(ICON_SRC)) {
    await cp(ICON_SRC, join(RES, "Explodex.icns"));
  }

  if (!release) {
    await writeFile(join(RES, "explodex-project-root"), ROOT);
  } else {
    await rm(join(RES, "explodex-project-root"), { force: true });
  }

  try {
    await run(["xattr", "-cr", DIST]);
  } catch {
    /* optional */
  }
  try {
    await run(["codesign", "--force", "--deep", "-s", "-", DIST]);
  } catch {
    /* optional for local dev */
  }

  console.log(`Packaged: ${DIST}`);
  console.log(`  SDK      -> ${join(RES, "explodex-sdk.js")}`);
  console.log(`  Injector -> ${join(RES, "cdp-inject.sh")} (+ cdp-inject-bin)`);
  console.log(`  Plugins  -> ${PLUGINS_DST}/`);

  return DIST;
}

if (import.meta.main) {
  packageApp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}