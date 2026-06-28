#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLauncher, uninstallLauncher } from "../lib/launcher-bundle.mjs";
import { injectOnly, launchFromApp, readPackageVersion, runDoctor, runUpdate } from "../lib/launch.mjs";
import { notifyFromCache, refreshUpdateCache } from "../lib/version-check.mjs";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const cliPath = fileURLToPath(import.meta.url);
const installDir = join(dirname(cliPath), "..");

export function parseCli(args) {
  if (args.length === 0) return { command: "launch" };
  const command = args[0];
  if (["--help", "-h", "help"].includes(command)) return { command: "help" };
  if (["--version", "-v", "version"].includes(command)) return { command: "version" };
  if (["--from-app", "--check-update", "inject", "update", "doctor"].includes(command)) return { command };
  if (["install-launcher", "uninstall-launcher"].includes(command)) {
    const flags = new Set(args.slice(1));
    const invalid = [...flags].filter((flag) => !["--system", "--force"].includes(flag));
    if (invalid.length) throw new Error(`Unknown option: ${invalid[0]}`);
    if (command === "uninstall-launcher" && flags.has("--force")) throw new Error("uninstall-launcher does not accept --force");
    return { command, system: flags.has("--system"), force: flags.has("--force") };
  }
  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`explodex — launch Codex with the Explodex plugin SDK

Usage:
  explodex                              Repair ~/Applications/Explodex.app and open it
  explodex install-launcher [--system] [--force]
  explodex uninstall-launcher [--system]
  explodex inject                       Inject into Codex on the Explodex debug port
  explodex update                       Run npm install -g explodex@latest
  explodex doctor                       Report launcher, Codex, port, and injector state
  explodex --version

Install globally with pnpm, Bun, npm, or Yarn.
Example: pnpm add -g explodex

--system installs /Applications/Explodex.app with macOS authorization.
--force is accepted only when repairing an existing Explodex-owned launcher.`);
}

async function openLauncher(path) {
  await new Promise((resolve, reject) => {
    const child = spawn("open", [path], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function runCli(args, dependencies = {}) {
  const options = parseCli(args);
  const version = await readPackageVersion();
  const fromApp = dependencies.launchFromApp ?? launchFromApp;
  const inject = dependencies.injectOnly ?? injectOnly;
  const update = dependencies.runUpdate ?? runUpdate;
  const doctor = dependencies.runDoctor ?? runDoctor;
  const refresh = dependencies.refreshUpdateCache ?? refreshUpdateCache;
  switch (options.command) {
    case "help": printHelp(); return;
    case "version": console.log(version); return;
    case "--check-update": await refresh(); return;
    case "--from-app": await fromApp(); return;
    case "inject": await inject(); return;
    case "update": await update(); return;
    case "doctor": console.log(JSON.stringify(await doctor(), null, 2)); return;
    case "install-launcher": {
      const result = await installLauncher({ system: options.system, force: options.force, version, packageRoot: installDir });
      console.log(`${result.repaired ? "Repaired" : "Installed"}: ${result.path}`);
      return;
    }
    case "uninstall-launcher": {
      const result = await uninstallLauncher({ system: options.system });
      console.log(result.removed ? `Removed: ${result.path}` : `Not installed: ${result.path}`);
      return;
    }
    case "launch": {
      const install = dependencies.installLauncher ?? installLauncher;
      const open = dependencies.openLauncher ?? openLauncher;
      const notify = dependencies.notifyFromCache ?? notifyFromCache;
      const result = await install({ version, packageRoot: installDir });
      await notify(version, { cliPath });
      await open(result.path);
      return;
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(cliPath); }
  catch { return process.argv[1] === cliPath; }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`explodex: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
