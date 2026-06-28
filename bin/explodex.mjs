#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import cac from "cac";
import { installLauncher, uninstallLauncher } from "../lib/launcher-bundle.mjs";
import { injectOnly, launchFromApp, readPackageVersion, runDoctor, runUpdate } from "../lib/launch.mjs";
import { notifyFromCache, refreshUpdateCache } from "../lib/version-check.mjs";

const cliPath = fileURLToPath(import.meta.url);
const installDir = join(dirname(cliPath), "..");

const HELP_NOTES = [
  { body: "Install globally with pnpm, Bun, npm, or Yarn.\n  Example: pnpm add -g explodex" },
];

function openLauncher(path) {
  return new Promise((resolve, reject) => {
    const child = spawn("open", [path], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function resolveDependencies(overrides = {}) {
  return {
    launchFromApp: overrides.launchFromApp ?? launchFromApp,
    injectOnly: overrides.injectOnly ?? injectOnly,
    runUpdate: overrides.runUpdate ?? runUpdate,
    runDoctor: overrides.runDoctor ?? runDoctor,
    refreshUpdateCache: overrides.refreshUpdateCache ?? refreshUpdateCache,
    installLauncher: overrides.installLauncher ?? installLauncher,
    uninstallLauncher: overrides.uninstallLauncher ?? uninstallLauncher,
    notifyFromCache: overrides.notifyFromCache ?? notifyFromCache,
    openLauncher: overrides.openLauncher ?? openLauncher,
  };
}

export function buildCli(deps, version) {
  const cli = cac("explodex");

  cli
    .command("", "Repair ~/Applications/Explodex.app and open it")
    .option("--from-app", "Internal: launch Codex from the app bundle")
    .option("--check-update", "Internal: refresh the cached update notice")
    .action(async (options) => {
      if (options.fromApp) return deps.launchFromApp();
      if (options.checkUpdate) return deps.refreshUpdateCache();
      const result = await deps.installLauncher({ version, packageRoot: installDir });
      await deps.notifyFromCache(version, { cliPath });
      await deps.openLauncher(result.path);
    });

  cli
    .command("inject", "Inject into Codex on the Explodex debug port")
    .action(() => deps.injectOnly());

  cli
    .command("update", "Update the global explodex install via your package manager")
    .action(() => deps.runUpdate());

  cli
    .command("doctor", "Report launcher, Codex, port, and injector state")
    .action(async () => console.log(JSON.stringify(await deps.runDoctor(), null, 2)));

  cli
    .command("install-launcher", "Install or repair the Explodex launcher app")
    .option("--system", "Install /Applications/Explodex.app with macOS authorization")
    .option("--force", "Repair an existing Explodex-owned launcher")
    .action(async (options) => {
      const result = await deps.installLauncher({
        system: Boolean(options.system),
        force: Boolean(options.force),
        version,
        packageRoot: installDir,
      });
      console.log(`${result.repaired ? "Repaired" : "Installed"}: ${result.path}`);
    });

  cli
    .command("uninstall-launcher", "Remove the Explodex launcher app")
    .option("--system", "Remove /Applications/Explodex.app")
    .action(async (options) => {
      const result = await deps.uninstallLauncher({ system: Boolean(options.system) });
      console.log(result.removed ? `Removed: ${result.path}` : `Not installed: ${result.path}`);
    });

  cli.help((sections) => [...sections, ...HELP_NOTES]);
  cli.version(version);
  return cli;
}

export async function runCli(args, dependencies = {}) {
  const version = await readPackageVersion();
  const cli = buildCli(resolveDependencies(dependencies), version);
  const parsed = cli.parse(["node", "explodex", ...args], { run: false });
  if (cli.matchedCommand?.name === "" && parsed.args.length) {
    throw new Error(`Unknown command: ${parsed.args[0]}`);
  }
  await cli.runMatchedCommand();
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
