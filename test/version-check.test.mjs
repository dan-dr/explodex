import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_INTERVAL_MS, isNewerVersion, notifyFromCache, refreshUpdateCache } from "../lib/version-check.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("update cache", () => {
  test("writes npm result and compares versions", async () => {
    const home = await mkdtemp(join(tmpdir(), "explodex-update-")); roots.push(home);
    await refreshUpdateCache({ home, now: 100, fetchImpl: async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) }) });
    expect(JSON.parse(await readFile(join(home, ".explodex", "update-check.json"), "utf8"))).toEqual({ checkedAt: 100, latest: "2.0.0" });
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
  });

  test("fresh cache does not spawn a background check", async () => {
    const home = await mkdtemp(join(tmpdir(), "explodex-update-")); roots.push(home);
    await refreshUpdateCache({ home, now: 100, fetchImpl: async () => ({ ok: true, json: async () => ({ version: "1.0.0" }) }) });
    let spawned = false;
    await notifyFromCache("1.0.0", { home, now: 100 + CHECK_INTERVAL_MS - 1, cliPath: "/tmp/cli", spawnImpl: () => { spawned = true; } });
    expect(spawned).toBe(false);
  });

  test("reports a newer version without prescribing an update command", async () => {
    const home = await mkdtemp(join(tmpdir(), "explodex-update-")); roots.push(home);
    await refreshUpdateCache({ home, now: 100, fetchImpl: async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) }) });
    const messages = [];
    const originalError = console.error;
    console.error = (message) => messages.push(message);
    try {
      await notifyFromCache("1.0.0", { home, now: 100, cliPath: "/tmp/cli" });
    } finally {
      console.error = originalError;
    }
    expect(messages).toEqual(["New explodex version available: 1.0.0 → 2.0.0. Reinstall with your package manager."]);
  });

  test("stale cache spawns one detached refresh", async () => {
    const home = await mkdtemp(join(tmpdir(), "explodex-update-")); roots.push(home);
    let args;
    let unref = false;
    await notifyFromCache("1.0.0", { home, now: 100, cliPath: "/tmp/cli", spawnImpl: (...value) => { args = value; return { unref: () => { unref = true; } }; } });
    expect(args[1]).toEqual(["/tmp/cli", "--check-update"]);
    expect(unref).toBe(true);
  });
});
