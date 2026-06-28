import { describe, expect, test } from "bun:test";
import { runCli } from "../bin/explodex.mjs";

describe("CLI routing", () => {
  test("default route repairs then opens", async () => {
    const calls = [];
    await runCli([], {
      installLauncher: async () => { calls.push("install"); return { path: "/tmp/Explodex.app" }; },
      notifyFromCache: async () => calls.push("notify"),
      openLauncher: async (path) => calls.push(`open:${path}`),
    });
    expect(calls).toEqual(["install", "notify", "open:/tmp/Explodex.app"]);
  });

  test("routes action commands and internal flags to their handlers", async () => {
    const calls = [];
    await runCli(["--from-app"], { launchFromApp: async () => calls.push("from-app") });
    await runCli(["inject"], { injectOnly: async () => calls.push("inject") });
    await runCli(["update"], { runUpdate: async () => calls.push("update") });
    await runCli(["--check-update"], { refreshUpdateCache: async () => calls.push("check") });
    expect(calls).toEqual(["from-app", "inject", "update", "check"]);
  });

  test("install-launcher forwards --system and --force", async () => {
    let received;
    await runCli(["install-launcher", "--system", "--force"], {
      installLauncher: async (options) => { received = options; return { path: "/tmp/Explodex.app", repaired: true }; },
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

  test("rejects unknown commands", async () => {
    await expect(runCli(["wat"])).rejects.toThrow("Unknown command: wat");
  });

  test("rejects unknown options", async () => {
    await expect(runCli(["uninstall-launcher", "--force"])).rejects.toThrow("Unknown option");
  });
});
