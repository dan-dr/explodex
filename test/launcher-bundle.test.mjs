import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLauncherBundle, installLauncher, isExplodexOwnedBundle } from "../lib/launcher-bundle.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function tempRoot() { const path = await mkdtemp(join(tmpdir(), "explodex-test-")); roots.push(path); return path; }

describe("launcher generation", () => {
  test("writes a lightweight shell/JXA bundle and ownership marker", async () => {
    const root = await tempRoot();
    const app = join(root, "Explodex.app");
    await generateLauncherBundle(app, "1.2.3");
    expect(await isExplodexOwnedBundle(app)).toBe(true);
    expect(await readFile(join(app, "Contents", "Info.plist"), "utf8")).toContain("1.2.3");
    expect(await readFile(join(app, "Contents", "MacOS", "Explodex"), "utf8")).toContain("explodex --launch");
    expect(await readFile(join(app, "Contents", "Resources", "progress.jxa"), "utf8")).toContain("NSProgressIndicator");
  });

  test("reinstalls an owned launcher idempotently", async () => {
    const home = await tempRoot();
    const first = await installLauncher({ home, version: "1.0.0" });
    await writeFile(join(first.path, "Contents", "Info.plist"), "broken");
    await writeFile(join(first.path, "Contents", "Resources", "stale-native-launcher"), "old");
    const second = await installLauncher({ home, version: "1.0.1" });
    expect(second.path).toBe(first.path);
    expect(await readFile(join(second.path, "Contents", "Info.plist"), "utf8")).toContain("1.0.1");
    await expect(readFile(join(second.path, "Contents", "Resources", "stale-native-launcher"))).rejects.toThrow();
  });

  test("refuses foreign bundles and rejects force without ownership", async () => {
    const home = await tempRoot();
    const app = join(home, "Applications", "Explodex.app");
    await mkdir(app, { recursive: true });
    await expect(installLauncher({ home, version: "1.0.0" })).rejects.toThrow("non-Explodex bundle");
    await rm(app, { recursive: true, force: true });
    await expect(installLauncher({ home, version: "1.0.0", force: true })).rejects.toThrow("--force");
  });

  test("allows force only for an owned launcher", async () => {
    const home = await tempRoot();
    await installLauncher({ home, version: "1.0.0" });
    const result = await installLauncher({ home, version: "1.0.1", force: true });
    expect(await readFile(join(result.path, "Contents", "Info.plist"), "utf8")).toContain("1.0.1");
  });

  test("recognizes a legacy Explodex plist as owned", async () => {
    const root = await tempRoot();
    const app = join(root, "Explodex.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.explodex.app</string><key>CFBundleExecutable</key><string>Explodex</string></dict></plist>');
    expect(await isExplodexOwnedBundle(app)).toBe(true);
  });
});
