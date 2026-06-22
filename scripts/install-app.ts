#!/usr/bin/env bun
/**
 * Package Explodex.app and install to /Applications.
 * Also ensures ~/.explodex/plugins exists for user-managed plugins.
 */

import { access, chmod, constants, cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { packageApp } from "./package-app.ts";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist", "Explodex.app");
const INSTALL_PATH = "/Applications/Explodex.app";
const USER_PLUGINS = join(homedir(), ".explodex", "plugins");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string[]): Promise<void> {
  const proc = spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed with exit code ${code}`);
}

async function installApp(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("install:app is macOS-only");
  }

  const iconScript = join(ROOT, "scripts", "build-icon.sh");
  if (await pathExists(iconScript)) {
    await run(["zsh", iconScript]);
  }

  await packageApp({ release: true });

  await mkdir(USER_PLUGINS, { recursive: true });
  console.log(`User plugins dir: ${USER_PLUGINS}`);

  if (await pathExists(INSTALL_PATH)) {
    console.log(`Replacing ${INSTALL_PATH}...`);
    await rm(INSTALL_PATH, { recursive: true, force: true });
  }

  await cp(DIST, INSTALL_PATH, { recursive: true });
  await chmod(join(INSTALL_PATH, "Contents", "MacOS", "Explodex"), 0o755);

  try {
    await run(["xattr", "-cr", INSTALL_PATH]);
  } catch {
    /* optional */
  }
  try {
    await run(["codesign", "--force", "--deep", "-s", "-", INSTALL_PATH]);
  } catch {
    /* optional */
  }

  console.log("");
  console.log(`Installed: ${INSTALL_PATH}`);
  console.log(`User plugins: ${USER_PLUGINS}`);
  console.log("");
  console.log("Launch Explodex from /Applications or run: open /Applications/Explodex.app");
}

if (import.meta.main) {
  installApp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}