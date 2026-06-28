import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { getPlatformAdapter } from "./platform.mjs";
import { getGlobalUpdateCommand } from "./package-manager.mjs";
import { getPackageJsonPath } from "./paths.mjs";

export async function readPackageVersion() {
  const pkg = JSON.parse(await readFile(getPackageJsonPath(), "utf8"));
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

async function runProcess(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${file} terminated by ${signal}`)) : code === 0 ? resolve() : reject(new Error(`${file} exited with code ${code}`)));
  });
}

export async function launchFromApp() { return (await getPlatformAdapter()).launch(); }
export async function injectOnly() { return (await getPlatformAdapter()).inject(); }
export async function runDoctor() { return (await getPlatformAdapter()).doctor(); }
export async function inspectState() { return (await getPlatformAdapter()).inspectLaunchState(); }
export async function runUpdate() {
  const command = getGlobalUpdateCommand();
  console.log(`$ ${command.join(" ")}`);
  await runProcess(command[0], command.slice(1));
}
