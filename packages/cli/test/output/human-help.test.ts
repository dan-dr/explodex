import { describe, expect, test } from "bun:test";
import { captureCli } from "../helpers/run-cli.ts";

describe("human help and usage (side-effect free)", () => {
  test("top-level help is readable and ChatGPT-only", async () => {
    const captured = await captureCli(["--help"]);
    expect(captured.exitCode).toBe(0);
    expect(captured.stdout).toContain("/Applications/ChatGPT.app");
    expect(captured.stdout).toContain("Explodex runs no daemon");
    expect(captured.stdout).toContain("compatibility probe");
    expect(captured.stdout).toContain("127.0.0.1:9333");
    expect(captured.stdout).toContain("main apply");
    expect(captured.stdout).not.toContain("Codex.app");
    expect(captured.stdout).not.toContain("supervisor");
    expect(captured.stdout).not.toContain("Unix socket");
  });

  test("group and command help work without host/CDP", async () => {
    const group = await captureCli(["help", "host"]);
    expect(group.exitCode).toBe(0);
    expect(group.stdout).toContain("host");
    expect(group.stdout).toContain("report");

    const command = await captureCli(["host", "report", "--help"]);
    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain("host report");
    expect(command.stdout).toContain("Aliases: inspect");
  });

  test("invalid usage prints concise error and usage, not full help", async () => {
    const captured = await captureCli(["host", "nope"]);
    expect(captured.exitCode).toBe(2);
    expect(captured.stderr).toContain("Unknown command");
    expect(captured.stderr).toContain("explodex host");
    expect(captured.stderr).toContain("--help");
    // Full root help sections should not dump to stderr for usage errors.
    expect(captured.stderr).not.toContain("Main recovery");
    expect(captured.stdout).toBe("");
  });

  test(
    "human host report names operation outcome without machine envelope",
    async () => {
      const home = `/tmp/explodex-cli-human-host-${process.pid}`;
      const captured = await captureCli(["--home", home, "host", "report"], {
        ...process.env,
        HOME: home,
      });
      // Host may be valid or invalid depending on the machine; either way no envelope.
      expect(
        captured.stdout.includes('"schemaVersion"') || captured.stderr.includes('"schemaVersion"'),
      ).toBe(false);
      const combined = captured.stdout + captured.stderr;
      expect(combined).toContain("Explodex host inspection");
      expect(combined).toContain("compatibility.status:");
    },
    30_000,
  );

  test("closed-stdin human help does not hang", async () => {
    const start = Date.now();
    const captured = await captureCli(["--help"]);
    const elapsed = Date.now() - start;
    expect(captured.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(5_000);
  });
});
