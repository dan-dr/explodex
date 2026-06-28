import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLauncherPath, getPackageRoot, pathExists } from "./paths.mjs";

const execFileAsync = promisify(execFile);
const OWNER_FILE = join("Contents", "Resources", "explodex-owner.json");
const OWNER_ID = "com.explodex.npm-launcher";

const plist = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Explodex</string>
<key>CFBundleIdentifier</key><string>com.explodex.app</string>
<key>CFBundleName</key><string>Explodex</string>
<key>CFBundleDisplayName</key><string>Explodex</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>Explodex</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict></plist>
`;

const shellLauncher = `#!/bin/zsh
set -euo pipefail
STATUS="${"${TMPDIR:-/tmp}"}/explodex-splash-$PPID.status"
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
LOG_DIR="$HOME/.explodex/logs"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/launcher.log") 2>&1
print -r -- "Preparing Explodex…" > "$STATUS"
osascript -l JavaScript "$RESOURCES/progress.jxa" "$STATUS" >/dev/null 2>&1 &
SPLASH_PID=$!
export EXPLODEX_SPLASH_STATUS="$STATUS"
/bin/zsh -lic 'exec explodex --from-app' || EXIT_CODE=$?
if (( ${"${EXIT_CODE:-0}"} != 0 )); then
  print -r -- "__ERROR__Launch failed — see ~/.explodex/logs/launcher.log" > "$STATUS"
  osascript -e 'display alert "Explodex could not start" message "See ~/.explodex/logs/launcher.log for details." as critical' 2>/dev/null || true
  sleep 1
fi
print -r -- "__DONE__" > "$STATUS"
wait "$SPLASH_PID" 2>/dev/null || true
rm -f "$STATUS"
exit ${"${EXIT_CODE:-0}"}
`;

const progressJxa = `ObjC.import("AppKit");
ObjC.import("Foundation");
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const rect = $.NSMakeRect(0, 0, 360, 132);
const style = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable;
const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(rect, style, $.NSBackingStoreBuffered, false);
panel.title = "Explodex";
panel.center;
const label = $.NSTextField.labelWithString("Preparing Explodex…");
label.frame = $.NSMakeRect(28, 74, 304, 24);
label.font = $.NSFont.systemFontOfSizeWeight(15, $.NSFontWeightMedium);
const progress = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(28, 42, 304, 14));
progress.indeterminate = true;
progress.style = $.NSProgressIndicatorStyleBar;
progress.startAnimation(null);
panel.contentView.addSubview(label);
panel.contentView.addSubview(progress);
panel.makeKeyAndOrderFront(null);
app.activateIgnoringOtherApps(true);
const statusPath = $.NSProcessInfo.processInfo.arguments.objectAtIndex(4).js;
while (true) {
  const value = $.NSString.stringWithContentsOfFileEncodingError(statusPath, $.NSUTF8StringEncoding, null);
  const text = value ? value.js.trim() : "";
  if (text === "__DONE__") break;
  if (text.startsWith("__ERROR__")) { label.stringValue = text.slice(9); progress.stopAnimation(null); }
  else if (text) label.stringValue = text;
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.12));
}
panel.orderOut(null);
`;

export async function isExplodexOwnedBundle(appPath) {
  try {
    const owner = JSON.parse(await readFile(join(appPath, OWNER_FILE), "utf8"));
    if (owner.owner === OWNER_ID) return true;
  } catch { /* check legacy bundle metadata below */ }
  try {
    const plistPath = join(appPath, "Contents", "Info.plist");
    const identifier = (await execFileAsync("plutil", ["-extract", "CFBundleIdentifier", "raw", plistPath])).stdout.trim();
    const executable = (await execFileAsync("plutil", ["-extract", "CFBundleExecutable", "raw", plistPath])).stdout.trim();
    return identifier === "com.explodex.app" && executable === "Explodex";
  } catch { return false; }
}

export async function generateLauncherBundle(appPath, version, packageRoot = getPackageRoot()) {
  const contents = join(appPath, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(join(contents, "Info.plist"), plist(version));
  await writeFile(join(macos, "Explodex"), shellLauncher);
  await chmod(join(macos, "Explodex"), 0o755);
  await writeFile(join(resources, "progress.jxa"), progressJxa);
  await writeFile(join(resources, "explodex-owner.json"), `${JSON.stringify({ owner: OWNER_ID, version })}\n`);
  const icon = join(packageRoot, "assets", "icon", "Explodex.icns");
  if (await pathExists(icon)) await cp(icon, join(resources, "Explodex.icns"));
  return appPath;
}

function shellQuote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }

export async function installLauncher({ home = homedir(), system = false, force = false, version, packageRoot } = {}) {
  const target = getLauncherPath({ home, system });
  const exists = await pathExists(target);
  const owned = exists && await isExplodexOwnedBundle(target);
  if (exists && !owned) throw new Error(`Refusing to replace non-Explodex bundle at ${target}`);
  if (force && !owned) throw new Error("--force is only valid for an existing Explodex-owned launcher");

  if (!system) {
    if (!exists) {
      await generateLauncherBundle(target, version, packageRoot);
    } else {
      const staging = join(dirname(target), `.Explodex.app.${randomUUID()}.new`);
      const previous = join(dirname(target), `.Explodex.app.${randomUUID()}.old`);
      await generateLauncherBundle(staging, version, packageRoot);
      await rename(target, previous);
      try { await rename(staging, target); }
      catch (error) { await rename(previous, target); throw error; }
      await rm(previous, { recursive: true, force: true });
    }
    return { path: target, repaired: exists };
  }

  const staging = join(tmpdir(), `explodex-launcher-${randomUUID()}`, basename(target));
  await generateLauncherBundle(staging, version, packageRoot);
  const replace = exists ? `/bin/rm -rf ${shellQuote(target)} && ` : "";
  const command = `/bin/mkdir -p ${shellQuote(dirname(target))} && ${replace}/usr/bin/ditto ${shellQuote(staging)} ${shellQuote(target)}`;
  try {
    await execFileAsync("osascript", ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges`]);
  } finally {
    await rm(dirname(staging), { recursive: true, force: true });
  }
  return { path: target, repaired: exists };
}

export async function uninstallLauncher({ home = homedir(), system = false } = {}) {
  const target = getLauncherPath({ home, system });
  if (!(await pathExists(target))) return { path: target, removed: false };
  if (!(await isExplodexOwnedBundle(target))) throw new Error(`Refusing to remove non-Explodex bundle at ${target}`);
  if (system) {
    await execFileAsync("osascript", ["-e", `do shell script ${JSON.stringify(`/bin/rm -rf ${shellQuote(target)}`)} with administrator privileges`]);
  } else {
    await execFileAsync("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(target)}`]);
  }
  return { path: target, removed: true };
}
