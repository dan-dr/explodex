#!/usr/bin/env bun
/**
 * Package dist/Explodex.app and symlink /Applications/Explodex.app to it.
 * After the one-time link, `bun run package` updates the installed app in place.
 */

import { chmod, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { packageApp } from "./package-app.ts";
import { pathExists, run } from "./utils.ts";

const ROOT = join(import.meta.dir, "..");
const DIST = resolve(ROOT, "dist", "Explodex.app");
const INSTALL_PATH = "/Applications/Explodex.app";
const USER_PLUGINS = join(homedir(), ".explodex", "plugins");

async function installPathResolvesToDist(): Promise<boolean> {
  try {
    const resolved = await realpath(INSTALL_PATH);
    return resolved === DIST;
  } catch {
    return false;
  }
}

async function linkApp(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("link:app is macOS-only");
  }

  const iconScript = join(ROOT, "scripts", "build-icon.sh");
  if (await pathExists(iconScript)) {
    await run(["zsh", iconScript]);
  }

  await packageApp();

  const bundledPlugins = join(DIST, "Contents", "Resources", "plugins");
  const bundledIds = (await readdir(bundledPlugins)).sort();
  console.log(`Bundled plugins (${bundledIds.length}): ${bundledIds.join(", ") || "(none)"}`);

  await mkdir(USER_PLUGINS, { recursive: true });
  console.log(`User plugins dir: ${USER_PLUGINS}`);

  if (await installPathResolvesToDist()) {
    console.log(`Already linked: ${INSTALL_PATH} -> ${DIST}`);
  } else {
    if (await pathExists(INSTALL_PATH)) {
      console.log(`Replacing ${INSTALL_PATH}...`);
      await rm(INSTALL_PATH, { recursive: true, force: true });
    }
    await symlink(DIST, INSTALL_PATH);
    console.log(`Linked: ${INSTALL_PATH} -> ${DIST}`);
  }

  await chmod(join(DIST, "Contents", "MacOS", "Explodex"), 0o755);

  console.log("");
  console.log("Dev install: /Applications/Explodex.app symlinks to dist/Explodex.app");
  console.log("Rebuild with: bun run package  (no reinstall needed)");
  console.log(`User plugins: ${USER_PLUGINS}`);
  console.log("");
  console.log("Launch: open /Applications/Explodex.app");
}

if (import.meta.main) {
  linkApp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
