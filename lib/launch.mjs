import { readFile } from "node:fs/promises";
import { getPlatformAdapter } from "./platform.mjs";
import { getPackageJsonPath } from "./paths.mjs";

export async function readPackageVersion() {
  const pkg = JSON.parse(await readFile(getPackageJsonPath(), "utf8"));
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

export async function launchFromApp() { return (await getPlatformAdapter()).launch(); }
export async function injectOnly() { return (await getPlatformAdapter()).inject(); }
export async function inspectState() { return (await getPlatformAdapter()).inspectLaunchState(); }
