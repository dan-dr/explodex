import { describe, expect, test } from "bun:test";
import { parseArgv } from "../../src/cli/parse.ts";

describe("CLI parse surface", () => {
  test("accepts global options anywhere before --", () => {
    const parsed = parseArgv(["host", "report", "--json", "--home", "/tmp/x"]);
    expect(parsed.kind).toBe("success");
    if (parsed.kind !== "success") return;
    expect(parsed.globals.json).toBe(true);
    expect(parsed.globals.home).toBe("/tmp/x");
    expect(parsed.resolved?.command.operation).toBe("host.report");
  });

  test("expands frozen aliases to canonical operations", () => {
    const host = parseArgv(["host", "inspect"]);
    expect(host.kind).toBe("success");
    if (host.kind === "success") {
      expect(host.resolved?.command.operation).toBe("host.report");
    }
    const compat = parseArgv(["compatibility", "report"]);
    expect(compat.kind).toBe("success");
    if (compat.kind === "success") {
      expect(compat.resolved?.command.operation).toBe("compatibility.status");
    }
  });

  test("rejects conflicting scalar global options", () => {
    const parsed = parseArgv(["--home", "/a", "--home", "/b", "host", "report"]);
    expect(parsed.kind).toBe("failure");
    if (parsed.kind !== "failure") return;
    expect(parsed.rendered.envelope.ok).toBe(false);
    if (!parsed.rendered.envelope.ok) {
      expect(parsed.rendered.envelope.error.code).toBe("usage.conflicting-options");
    }
  });

  test("collapses identical and normalized-identical scalar globals", () => {
    const parsed = parseArgv([
      "--home",
      "/same",
      "plugin",
      "status",
      "--home=/same",
      "--timeout",
      "60s",
      "--timeout=1m",
    ]);
    expect(parsed.kind).toBe("success");
    if (parsed.kind !== "success") return;
    expect(parsed.globals.home).toBe("/same");
    expect(parsed.globals.timeoutMs).toBe(60_000);
  });

  test("preserves every token after -- as positional data", () => {
    const parsed = parseArgv([
      "plugin",
      "validate",
      "--",
      "--json",
      "--timeout",
      "1ms",
    ]);
    expect(parsed.kind).toBe("success");
    if (parsed.kind !== "success") return;
    expect(parsed.globals.json).toBe(false);
    expect(parsed.globals.timeoutMs).toBe(60_000);
    expect(parsed.endOfOptions).toEqual(["--json", "--timeout", "1ms"]);
  });

  test("rejects invalid timeout grammar", () => {
    for (const value of ["60", "1.5s", "-1s", "1m30s", "0s"]) {
      const parsed = parseArgv(["--timeout", value, "host", "report"]);
      expect(parsed.kind).toBe("failure");
      if (parsed.kind === "failure" && !parsed.rendered.envelope.ok) {
        expect(parsed.rendered.envelope.error.code).toBe("usage.invalid-value");
      }
    }
  });

  test("accepts valid timeout values", () => {
    const parsed = parseArgv(["--timeout", "90s", "host", "report"]);
    expect(parsed.kind).toBe("success");
    if (parsed.kind === "success") {
      expect(parsed.globals.timeoutMs).toBe(90_000);
    }
  });

  test("help wins over version", () => {
    const parsed = parseArgv(["--version", "--help"]);
    expect(parsed.kind).toBe("success");
    if (parsed.kind === "success") {
      expect(parsed.globals.help).toBe(true);
      expect(parsed.globals.version).toBe(true);
    }
  });
});
