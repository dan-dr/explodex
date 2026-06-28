import { describe, expect, test } from "bun:test";
import { parseCli, runCli } from "../bin/explodex.mjs";

describe("CLI routing", () => {
  test("parses public and internal routes", () => {
    expect(parseCli([])).toEqual({ command: "launch" });
    expect(parseCli(["install-launcher", "--system", "--force"])).toEqual({ command: "install-launcher", system: true, force: true });
    expect(parseCli(["--from-app"])).toEqual({ command: "--from-app" });
    expect(() => parseCli(["wat"])).toThrow("Unknown command");
  });

  test("default route repairs then opens", async () => {
    const calls = [];
    await runCli([], {
      installLauncher: async () => { calls.push("install"); return { path: "/tmp/Explodex.app" }; },
      notifyFromCache: async () => calls.push("notify"),
      openLauncher: async (path) => calls.push(`open:${path}`),
    });
    expect(calls).toEqual(["install", "notify", "open:/tmp/Explodex.app"]);
  });

  test("routes action commands to their handlers", async () => {
    const calls = [];
    await runCli(["--from-app"], { launchFromApp: async () => calls.push("from-app") });
    await runCli(["inject"], { injectOnly: async () => calls.push("inject") });
    await runCli(["update"], { runUpdate: async () => calls.push("update") });
    await runCli(["--check-update"], { refreshUpdateCache: async () => calls.push("check") });
    expect(calls).toEqual(["from-app", "inject", "update", "check"]);
  });
});
