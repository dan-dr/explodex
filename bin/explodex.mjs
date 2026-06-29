#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import { installLauncher, uninstallLauncher } from "../lib/launcher-bundle.mjs";
import { injectOnly, inspectState, launchFromApp, readPackageVersion } from "../lib/launch.mjs";
import { notifyFromCache, refreshUpdateCache } from "../lib/version-check.mjs";
import { getLauncherPath, pathExists } from "../lib/paths.mjs";
import { installPluginCreatorSkill, isPluginCreatorSkillInstalled, SKILL_INSTALL_COMMAND } from "../lib/skill-install.mjs";

const cliPath = fileURLToPath(import.meta.url);
const installDir = join(dirname(cliPath), "..");
const CODEX_APP = "/Applications/Codex.app";

const FLAGS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  yes: { type: "boolean", short: "y" },
  system: { type: "boolean" },
  force: { type: "boolean" },
  launch: { type: "boolean" },
  "from-app": { type: "boolean" },
  "check-update": { type: "boolean" },
};

// Options each command accepts (besides the always-global --help/--version).
const ALLOWED_OPTIONS = {
  "": ["yes", "launch", "from-app", "check-update"],
  inject: [],
  doctor: [],
  "install-skill": [],
  "install-launcher": ["system", "force"],
  "uninstall-launcher": ["system"],
};

// Friendlier aliases for the verbose launcher commands.
const COMMAND_ALIASES = { install: "install-launcher", uninstall: "uninstall-launcher" };

export function parseCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: false, options: FLAGS });
  if (values.help) return { command: "help" };
  if (values.version && positionals.length === 0) return { command: "version" };

  const command = COMMAND_ALIASES[positionals[0]] ?? positionals[0] ?? "";
  if (!(command in ALLOWED_OPTIONS)) throw new Error(`Unknown command: ${positionals[0]}`);
  if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);

  const allowed = new Set([...ALLOWED_OPTIONS[command], "help", "version"]);
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) continue;
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
  }

  return {
    command,
    system: Boolean(values.system),
    force: Boolean(values.force),
    yes: Boolean(values.yes),
    launch: Boolean(values.launch || values["from-app"]),
    checkUpdate: Boolean(values["check-update"]),
  };
}

function printHelp() {
  console.log(`explodex — launch Codex with the Explodex plugin SDK

Usage:
  explodex                    Open Explodex (offers to create the launcher app if missing)
  explodex install            Install the launcher app without launching
  explodex uninstall          Remove the launcher app
  explodex inject             Inject into Codex on the Explodex debug port
  explodex install-skill      Install the Explodex plugin creator skill
  explodex doctor             Re-run onboarding checks for the app and skill
  explodex install [--system] [--force]
  explodex uninstall [--system]

Options:
  -y, --yes                   Skip the confirmation prompt and create the app
  -h, --help                  Show this help
  -v, --version               Print the version

When the launcher app is missing, explodex asks before creating it. Decline and
explodex still launches Codex and injects plugins this once, just without
creating the app (run \`explodex install\` to add it later).
\`install\`/\`uninstall\` are aliases for \`install-launcher\`/\`uninstall-launcher\`.
--system targets /Applications and requests authorization.`);
}

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
    inspectState: overrides.inspectState ?? inspectState,
    injectOnly: overrides.injectOnly ?? injectOnly,
    installSkill: overrides.installSkill ?? installPluginCreatorSkill,
    skillInstalled: overrides.skillInstalled ?? isPluginCreatorSkillInstalled,
    refreshUpdateCache: overrides.refreshUpdateCache ?? refreshUpdateCache,
    installLauncher: overrides.installLauncher ?? installLauncher,
    uninstallLauncher: overrides.uninstallLauncher ?? uninstallLauncher,
    notifyFromCache: overrides.notifyFromCache ?? notifyFromCache,
    openLauncher: overrides.openLauncher ?? openLauncher,
    launcherExists: overrides.launcherExists ?? (() => pathExists(getLauncherPath())),
    systemLauncherExists: overrides.systemLauncherExists ?? (() => pathExists(getLauncherPath({ system: true }))),
    codexInstalled: overrides.codexInstalled ?? (() => pathExists(CODEX_APP)),
    hasRunBefore: overrides.hasRunBefore ?? (() => pathExists(join(homedir(), ".explodex"))),
    makeUi: overrides.makeUi ?? makeUi,
  };
}

// Clack draws nicely on a TTY; piped output (logs, CI, tests) falls back to plain lines.
function makeUi() {
  const pretty = Boolean(process.stdout.isTTY);
  if (pretty) {
    return {
      pretty,
      intro: (m) => clack.intro(m),
      outro: (m) => clack.outro(m),
      note: (m, title) => clack.note(m, title),
      info: (m) => clack.log.info(m),
      warn: (m) => clack.log.warn(m),
      cancel: (m) => clack.cancel(m),
      spinner: () => clack.spinner(),
      confirm: async (message, initialValue = true) => {
        const answer = await clack.confirm({ message, initialValue });
        if (clack.isCancel(answer)) return null;
        return answer;
      },
    };
  }
  const noopSpinner = () => ({ start() {}, stop(m) { if (m) console.log(m); }, message() {} });
  return {
    pretty,
    intro: () => {},
    outro: (m) => { if (m) console.log(m); },
    note: (m, title) => console.log(title ? `${title}\n${m}` : m),
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    cancel: (m) => console.warn(m),
    spinner: noopSpinner,
    confirm: async () => true,
  };
}

const WELCOME_NOTE = `Explodex wraps the Codex desktop app with a plugin SDK.

To open Codex with your plugins, Explodex uses a launcher app:
  - Creates a launcher app at ~/Applications/Explodex.app
  - Uses ~/.explodex for your plugins and logs
  - Opens Explodex, which starts Codex with your plugins injected

It does not modify, move, or re-sign Codex itself.`;

// Describe what opening the launcher will do, based on the current Codex state.
function describeState(state, port) {
  switch (state) {
    case "foreign-port":
      return {
        warn: `Port ${port} is held by another process — the launch may fail until it's freed (set EXPLODEX_DEBUG_PORT to change it).`,
        outro: "Opening Explodex…",
      };
    default:
      return { outro: "Opening Explodex — Codex will start with your plugins." };
  }
}

async function openExisting(deps, version, path, state, port, ui) {
  const { warn, outro } = describeState(state, port);
  if (warn) ui.warn(warn);
  await deps.notifyFromCache(version, { cliPath });
  await deps.openLauncher(path);
  ui.outro(outro);
}

async function runLaunch(parsed, deps, version) {
  if (parsed.launch) return deps.launchFromApp();
  if (parsed.checkUpdate) return deps.refreshUpdateCache();

  const ui = deps.makeUi();
  const target = getLauncherPath();
  ui.intro("Running Explodex");

  const firstRun = !(await deps.hasRunBefore());
  if (firstRun) {
    ui.note(WELCOME_NOTE, "Welcome");
    const skillInstalled = await deps.skillInstalled();
    if (!skillInstalled && (parsed.yes || ui.pretty)) {
      const install = parsed.yes || await ui.confirm("Install plugin creator skill (Recommended)");
      if (install) {
        ui.info(`$ ${SKILL_INSTALL_COMMAND.join(" ")}`);
        await deps.installSkill();
      }
    }
  }

  // If Codex is already running with Explodex, there's nothing to do — don't
  // reopen, re-inject, or touch the launcher.
  const { state, port } = await deps.inspectState().catch(() => ({ state: "unknown" }));
  if (state === "debug-codex") {
    ui.outro("Codex is already running with Explodex — nothing to do.");
    return;
  }
  if (state === "plain-codex") {
    // We don't quit Codex for the user; ask them to quit it first.
    ui.warn("Codex is running without Explodex.");
    ui.outro("Quit Codex, then run `explodex` again to start it with your plugins.");
    return;
  }

  // The launcher app is created only on first setup (or via `explodex install`),
  // never silently reinstalled on launch. If it exists, just open it.
  if (await deps.launcherExists()) {
    await openExisting(deps, version, target, state, port, ui);
    return;
  }

  // Missing launcher app: offer to create it (TTY only; --yes/non-TTY auto-creates).
  if (ui.pretty && !parsed.yes) {
    ui.warn(`No launcher app found at ${target}.`);
    if (!(await deps.codexInstalled())) {
      ui.warn(`Codex isn't installed at ${CODEX_APP}. Install Codex first — Explodex launches it but doesn't bundle it.`);
    }
    const ok = await ui.confirm("Create the Explodex launcher app now?");
    if (!ok) {
      // Decline = don't create the app, but still do what it would do: start
      // Codex with remote debugging and inject the SDK + plugins now.
      // launchFromApp streams its own injector progress, so no spinner here.
      ui.info("Skipping the launcher app — launching Codex with plugins now.");
      ui.info("Run `explodex install` to add the launcher app for next time.");
      await deps.launchFromApp();
      ui.outro("Codex is starting with your plugins.");
      return;
    }
  }

  const spin = ui.spinner();
  spin.start("Creating the Explodex launcher app");
  const result = await deps.installLauncher({ version, packageRoot: installDir });
  spin.stop(`Created launcher at ${result.path}`);
  await openExisting(deps, version, result.path, state, port, ui);
}

async function runDoctorOnboarding(deps, version) {
  const ui = deps.makeUi();
  let launcherInstalled = await deps.launcherExists() || await deps.systemLauncherExists();
  let skillInstalled = await deps.skillInstalled();

  ui.intro("Explodex onboarding check");
  ui.info(`Explodex.app: ${launcherInstalled ? "installed" : "missing"}`);
  ui.info(`Plugin creator skill: ${skillInstalled ? "installed" : "missing"}`);

  if (!launcherInstalled && ui.pretty && await ui.confirm("Install Explodex.app?")) {
    const result = await deps.installLauncher({ version, packageRoot: installDir });
    ui.info(`Installed: ${result.path}`);
    launcherInstalled = true;
  }
  if (!skillInstalled && ui.pretty && await ui.confirm("Install plugin creator skill (Recommended)")) {
    ui.info(`$ ${SKILL_INSTALL_COMMAND.join(" ")}`);
    await deps.installSkill();
    skillInstalled = true;
  }

  ui.outro(launcherInstalled && skillInstalled ? "Onboarding checks passed." : "Onboarding check complete.");
}

export async function runCli(args, dependencies = {}) {
  const parsed = parseCli(args);
  const version = await readPackageVersion();
  const deps = resolveDependencies(dependencies);

  switch (parsed.command) {
    case "help": printHelp(); return;
    case "version": console.log(version); return;
    case "inject": await deps.injectOnly(); return;
    case "install-skill": await deps.installSkill(); return;
    case "doctor": await runDoctorOnboarding(deps, version); return;
    case "install-launcher": {
      const result = await deps.installLauncher({ system: parsed.system, force: parsed.force, version, packageRoot: installDir });
      console.log(`Installed: ${result.path}`);
      return;
    }
    case "uninstall-launcher": {
      const result = await deps.uninstallLauncher({ system: parsed.system });
      console.log(result.removed ? `Removed: ${result.path}` : `Not installed: ${result.path}`);
      return;
    }
    case "": await runLaunch(parsed, deps, version); return;
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
