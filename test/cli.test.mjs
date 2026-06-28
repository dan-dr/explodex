import { describe, expect, test } from "bun:test";
import { parseCli, runCli } from "../bin/explodex.mjs";

describe("CLI parsing", () => {
  test("parses default, internal flags, and subcommands", () => {
    expect(parseCli([])).toMatchObject({ command: "" });
    expect(parseCli(["--launch"])).toMatchObject({ command: "", launch: true });
    expect(parseCli(["--from-app"])).toMatchObject({ command: "", launch: true });
    expect(parseCli(["--check-update"])).toMatchObject({ command: "", checkUpdate: true });
    expect(parseCli(["install-launcher", "--system", "--force"])).toMatchObject({ command: "install-launcher", system: true, force: true });
    expect(parseCli(["--help"])).toEqual({ command: "help" });
    expect(parseCli(["--version"])).toEqual({ command: "version" });
  });

  test("normalizes install/uninstall aliases", () => {
    expect(parseCli(["install", "--force"])).toMatchObject({ command: "install-launcher", force: true });
    expect(parseCli(["uninstall", "--system"])).toMatchObject({ command: "uninstall-launcher", system: true });
  });

  test("rejects unknown commands and options", () => {
    expect(() => parseCli(["wat"])).toThrow("Unknown command: wat");
    expect(() => parseCli(["uninstall-launcher", "--force"])).toThrow("Unknown option: --force");
  });
});

describe("CLI launch flow", () => {
  const trackingDeps = (calls, over) => ({
    inspectState: async () => ({ state: "stopped", port: 9333 }),
    launcherExists: async () => true,
    installLauncher: async () => { calls.push("install"); return { path: "/tmp/Explodex.app" }; },
    notifyFromCache: async () => calls.push("notify"),
    openLauncher: async () => calls.push("open"),
    ...over,
  });

  test("does nothing when Codex already runs with Explodex", async () => {
    const calls = [];
    await runCli([], trackingDeps(calls, { inspectState: async () => ({ state: "debug-codex", port: 9333 }) }));
    expect(calls).toEqual([]);
  });

  test("opens an existing launcher without reinstalling it", async () => {
    const calls = [];
    await runCli([], trackingDeps(calls, { launcherExists: async () => true }));
    expect(calls).toEqual(["notify", "open"]);
  });

  test("creates the launcher when missing (non-interactive), then opens it", async () => {
    const calls = [];
    await runCli([], trackingDeps(calls, { launcherExists: async () => false }));
    expect(calls).toEqual(["install", "notify", "open"]);
  });
});

describe("CLI routing", () => {
  test("routes internal flags and subcommands to their handlers", async () => {
    const calls = [];
    await runCli(["--launch"], { launchFromApp: async () => calls.push("launch") });
    await runCli(["--from-app"], { launchFromApp: async () => calls.push("from-app") });
    await runCli(["inject"], { injectOnly: async () => calls.push("inject") });
    await runCli(["update"], { runUpdate: async () => calls.push("update") });
    await runCli(["--check-update"], { refreshUpdateCache: async () => calls.push("check") });
    expect(calls).toEqual(["launch", "from-app", "inject", "update", "check"]);
  });

  test("install-launcher forwards --system and --force", async () => {
    let received;
    await runCli(["install-launcher", "--system", "--force"], {
      installLauncher: async (options) => { received = options; return { path: "/tmp/Explodex.app" }; },
    });
    expect(received).toMatchObject({ system: true, force: true });
  });

  test("uninstall-launcher forwards --system", async () => {
    let received;
    await runCli(["uninstall-launcher", "--system"], {
      uninstallLauncher: async (options) => { received = options; return { path: "/tmp/Explodex.app", removed: true }; },
    });
    expect(received).toEqual({ system: true });
  });
});
