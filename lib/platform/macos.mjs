import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decideLaunchState } from "../platform.mjs";
import { getInjectorPath, getLogDir, getPluginsDir, getSdkPath, getUserPluginsDir, pathExists } from "../paths.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 9333;
const CODEX_APP = "/Applications/Codex.app";
const CODEX_BIN = "/Applications/Codex.app/Contents/MacOS/Codex";

async function command(file, args) {
  try { return (await execFileAsync(file, args, { encoding: "utf8" })).stdout.trim(); }
  catch (error) { return error?.stdout?.trim?.() ?? ""; }
}

async function portPids(port) {
  const output = await command("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"]);
  return output.split(/\s+/).filter(Boolean);
}

async function processArgs(pid) { return command("ps", ["-p", pid, "-o", "args="]); }
async function codexIsRunning() {
  return (await command("osascript", ["-e", 'application "Codex" is running'])) === "true";
}

export async function inspectLaunchState(port = Number(process.env.EXPLODEX_DEBUG_PORT ?? DEFAULT_PORT)) {
  const pids = await portPids(port);
  const owners = await Promise.all(pids.map(async (pid) => ({ pid, args: await processArgs(pid) })));
  const codexRunning = await codexIsRunning();
  const portOwnedByCodex = owners.some(({ args }) => args.includes("Codex.app/Contents/MacOS/Codex"));
  return {
    state: decideLaunchState({ portListening: pids.length > 0, portOwnedByCodex, codexRunning }),
    port,
    owners,
    codexRunning,
  };
}

export function installedCodexEnvironment(source = process.env) {
  const env = { ...source };
  delete env.CODEX_ELECTRON_USER_DATA_PATH;
  delete env.EXPLODEX_USER_DATA;
  return env;
}

async function runProcess(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${file} terminated by ${signal}`)) : code === 0 ? resolve() : reject(new Error(`${file} exited with code ${code}`)));
  });
}

export async function inject(port = DEFAULT_PORT, home = homedir()) {
  const injector = getInjectorPath();
  if (!(await pathExists(injector))) throw new Error(`Missing npm injector at ${injector}. Run npm install -g explodex again.`);
  await mkdir(getUserPluginsDir(home), { recursive: true });
  await runProcess(process.execPath, [injector], { env: {
    ...process.env,
    HOME: home,
    EXPLODEX_DEBUG_PORT: String(port),
    EXPLODEX_SDK_PATH: getSdkPath(),
    EXPLODEX_BUNDLED_PLUGINS_DIR: getPluginsDir(),
    EXPLODEX_USER_PLUGINS_DIR: getUserPluginsDir(home),
    EXPLODEX_PLUGINS_DIR: "",
  }});
}

async function activateCodex() {
  // `open` foregrounds a running app through LaunchServices without sending an
  // Apple Event, so it avoids the Automation prompt that AppleScript `activate`
  // attributes to the controlling terminal.
  await command("open", ["-a", CODEX_APP]);
}

async function notifyQuitCodex() {
  const message = "Codex is running without Explodex. Quit Codex, then open Explodex again to start it with your plugins.";
  await command("osascript", ["-e", `display alert "Quit Codex first" message ${JSON.stringify(message)}`]);
}

async function waitForDebugPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await inspectLaunchState(port);
    if (state.state === "debug-codex") return;
    if (state.state === "foreign-port") throw new Error(`Port ${port} was claimed by another process`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Codex debug port ${port}`);
}

function splashStatus(value) {
  const path = process.env.EXPLODEX_SPLASH_STATUS;
  if (path) return import("node:fs/promises").then(({ writeFile }) => writeFile(path, value).catch(() => {}));
}

export async function launch({ port = Number(process.env.EXPLODEX_DEBUG_PORT ?? DEFAULT_PORT), home = homedir() } = {}) {
  const logDir = getLogDir(home);
  await mkdir(logDir, { recursive: true });
  const launcherLog = join(logDir, "launcher.log");
  const log = async (message) => appendFile(launcherLog, `${new Date().toISOString()} ${message}\n`);
  if (!(await pathExists(CODEX_BIN))) throw new Error(`Codex is missing at /Applications/Codex.app. Install Codex, then retry. Logs: ${launcherLog}`);

  let info = await inspectLaunchState(port);
  await log(`state=${info.state} port=${port}`);
  if (info.state === "foreign-port") {
    const owner = info.owners[0];
    throw new Error(`Port ${port} is owned by ${owner?.args || `PID ${owner?.pid || "unknown"}`}. Free it or set EXPLODEX_DEBUG_PORT. Logs: ${launcherLog}`);
  }
  if (info.state === "plain-codex") {
    // Explodex no longer quits Codex for the user; ask them to quit it first.
    await splashStatus("Quit Codex first…");
    await notifyQuitCodex();
    await log("plain-codex: asked user to quit Codex");
    return { state: "needs-quit", log: launcherLog };
  }
  if (info.state === "stopped") {
    await splashStatus("Launching Codex…");
    // Launch through LaunchServices (`open`) instead of spawning the inner
    // Mach-O binary. A spawned child inherits the terminal's TCC identity, so
    // Codex's own permission prompts (Screen Recording, etc.) get attributed to
    // the terminal. `open -a` makes Codex its own responsible process, so its
    // existing grants apply. `--args` passes the debug switch to Electron.
    try {
      await execFileAsync("open", ["-a", CODEX_APP, "--args", `--remote-debugging-port=${port}`]);
    } catch (error) {
      throw new Error(`Could not launch Codex via 'open': ${error?.message ?? error}. Logs: ${launcherLog}`);
    }
    try { await waitForDebugPort(port); } catch (error) { throw new Error(`${error.message}. See ${launcherLog}`); }
  }
  await splashStatus("Injecting plugins…");
  try { await inject(port, home); } catch (error) { throw new Error(`Injection failed: ${error.message}. Logs: ${launcherLog}`); }
  await splashStatus("Opening Codex…");
  await activateCodex();
  return { state: info.state === "stopped" ? "launched" : "injected", log: launcherLog };
}
