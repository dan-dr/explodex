#!/usr/bin/env bun
/**
 * Build dist/Explodex.app from templates/explodex-app + current SDK/plugins.
 * Local dev script — Bun TypeScript. Bundled app contents stay shell-only.
 */

import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists, run } from "./utils.ts";

const ROOT = join(import.meta.dir, "..");
const TEMPLATE = join(ROOT, "templates", "explodex-app");
const SPLASH_TEMPLATE = join(ROOT, "templates", "splash-app");
const DIST = join(ROOT, "dist", "Explodex.app");
const RES = join(DIST, "Contents", "Resources");
const SPLASH_APP = join(RES, "Splash.app");
const PLUGINS_SRC = join(ROOT, "plugins");
const PLUGINS_DST = join(RES, "plugins");
const ICON_SRC = join(ROOT, "assets", "icon", "Explodex.icns");

export async function packageApp(): Promise<string> {
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

  try {
    await cp(SPLASH_TEMPLATE, SPLASH_APP, { recursive: true });
    await mkdir(join(SPLASH_APP, "Contents", "MacOS"), { recursive: true });
    const splashBin = join(SPLASH_APP, "Contents", "MacOS", "Splash");
    await run([
      "swiftc",
      "-O",
      join(ROOT, "scripts", "splash-screen.swift"),
      "-o",
      splashBin,
      "-framework",
      "AppKit",
      "-framework",
      "QuartzCore",
    ]);
    await chmod(splashBin, 0o755);
    if (await pathExists(ICON_SRC)) {
      const splashRes = join(SPLASH_APP, "Contents", "Resources");
      await mkdir(splashRes, { recursive: true });
      await cp(ICON_SRC, join(splashRes, "AppIcon.icns"));
    }
  } catch {
    await rm(SPLASH_APP, { recursive: true, force: true });
    console.warn("  Splash     -> skipped (swiftc unavailable or compile failed)");
  }

  if (await pathExists(ICON_SRC)) {
    await cp(ICON_SRC, join(RES, "Explodex.icns"));
  }

  await writeFile(join(RES, "explodex-project-root"), ROOT);

  console.log(`Packaged: ${DIST}`);
  console.log(`  SDK      -> ${join(RES, "explodex-sdk.js")}`);
  console.log(`  Injector -> ${join(RES, "cdp-inject.sh")} (+ cdp-inject-bin)`);
  if (await pathExists(SPLASH_APP)) {
    console.log(`  Splash     -> ${SPLASH_APP}`);
  }
  console.log(`  Plugins  -> ${PLUGINS_DST}/`);

  return DIST;
}

if (import.meta.main) {
  packageApp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
