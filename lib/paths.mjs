import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function getPackageRoot() { return packageRoot; }
export function getPackageJsonPath() { return join(packageRoot, "package.json"); }
export function getSdkPath() { return join(packageRoot, "sdk", "explodex-sdk.js"); }
export function getPluginsDir() { return join(packageRoot, "plugins"); }
export function getInjectorPath() { return join(packageRoot, "lib", "cdp-inject.mjs"); }
export function getUserPluginsDir(home = homedir()) { return join(home, ".explodex", "plugins"); }
export function getLogDir(home = homedir()) { return join(home, ".explodex", "logs"); }
export function getLauncherPath({ home = homedir(), system = false } = {}) {
  return system ? "/Applications/Explodex.app" : join(home, "Applications", "Explodex.app");
}

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
