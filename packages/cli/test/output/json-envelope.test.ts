import { describe, expect, test } from "bun:test";
import {
  exitCodeForError,
  serializeEnvelope,
  successEnvelope,
  failureEnvelope,
  CLI_SCHEMA_VERSION,
} from "../../src/output/envelope.ts";
import { assertSingleJsonValue, captureCli } from "../helpers/run-cli.ts";

describe("schemaVersion-1 JSON envelope", () => {
  test("serializes success with exact key order", () => {
    const envelope = successEnvelope("host.report", { okField: true }, []);
    const text = serializeEnvelope(envelope);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "ok",
      "operation",
      "result",
      "warnings",
    ]);
    expect(parsed.schemaVersion).toBe(CLI_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
  });

  test("serializes failure with exact key order and optional details", () => {
    const envelope = failureEnvelope("cli.parse", {
      code: "usage.unknown-command",
      message: "Unknown command.",
      details: { command: "nope" },
    });
    const text = serializeEnvelope(envelope);
    const parsed = JSON.parse(text) as {
      error: Record<string, unknown>;
      [key: string]: unknown;
    };
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "ok",
      "operation",
      "error",
      "warnings",
    ]);
    expect(Object.keys(parsed.error)).toEqual(["code", "message", "details"]);
  });

  test("maps frozen baseline codes to exit classifications", () => {
    expect(exitCodeForError("usage.unknown-command")).toBe(2);
    expect(exitCodeForError("usage.command-unavailable")).toBe(3);
    expect(exitCodeForError("operation.busy")).toBe(4);
    expect(exitCodeForError("operation.timeout")).toBe(5);
    expect(exitCodeForError("operation.interrupted")).toBe(130);
    expect(exitCodeForError("operation.internal")).toBe(1);
    expect(exitCodeForError("host.not-found")).toBe(1);
  });

  test("keeps JSON stdout machine clean on usage failures regardless of option order", async () => {
    const cases = [
      ["--json", "not-a-command"],
      ["not-a-command", "--json"],
      ["host", "nope", "--json"],
    ];
    for (const argv of cases) {
      const captured = await captureCli(argv);
      expect(captured.exitCode).toBe(2);
      const parsed = assertSingleJsonValue(captured.stdout) as {
        schemaVersion: number;
        ok: boolean;
        operation: string;
        error: { code: string; message: string };
        warnings: unknown[];
      };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("usage.unknown-command");
      expect(Array.isArray(parsed.warnings)).toBe(true);
      // Diagnostics only on stderr when present
      expect(captured.stdout.includes("Usage:")).toBe(false);
      expect(captured.stdout.includes("error:")).toBe(false);
    }
  });

  test("help --json emits one success envelope with operation help", async () => {
    const captured = await captureCli(["--json", "--help"]);
    expect(captured.exitCode).toBe(0);
    const parsed = assertSingleJsonValue(captured.stdout) as {
      ok: boolean;
      operation: string;
      result: { path: string; text: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("help");
    expect(typeof parsed.result.text).toBe("string");
    expect(parsed.result.text.includes("/Applications/ChatGPT.app")).toBe(true);
    expect(parsed.result.text.includes("daemon")).toBe(true);
  });

  test("version --json emits operation version", async () => {
    const captured = await captureCli(["--json", "--version"]);
    expect(captured.exitCode).toBe(0);
    const parsed = assertSingleJsonValue(captured.stdout) as {
      ok: boolean;
      operation: string;
      result: { version: string; name: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("version");
    expect(parsed.result.name).toBe("explodex");
    expect(typeof parsed.result.version).toBe("string");
  });

  test("reserved commands return usage.command-unavailable without side effects", async () => {
    // plugin create/validate/build/package/artifact validate are available; use install.
    const captured = await captureCli(["--json", "plugin", "install", "x"]);
    expect(captured.exitCode).toBe(3);
    const parsed = assertSingleJsonValue(captured.stdout) as {
      ok: boolean;
      operation: string;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.operation).toBe("plugin.install");
    expect(parsed.error.code).toBe("usage.command-unavailable");
  });

  test(
    "aliases emit canonical dotted operation",
    async () => {
      const home = `/tmp/explodex-cli-alias-${process.pid}`;
      const captured = await captureCli(
        ["--json", "--home", home, "host", "inspect"],
        { ...process.env, HOME: home },
      );
      const parsed = assertSingleJsonValue(captured.stdout) as {
        operation: string;
        schemaVersion: number;
      };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.operation).toBe("host.report");
    },
    30_000,
  );

  test("omits secret-shaped keys from JSON details", () => {
    const envelope = failureEnvelope("cli.parse", {
      code: "operation.internal",
      message: "boom",
      details: {
        token: "secret-token",
        path: "/safe/path",
        cookie: "session=1",
      },
    });
    const parsed = JSON.parse(serializeEnvelope(envelope)) as {
      error: { details: Record<string, unknown> };
    };
    expect(parsed.error.details.path).toBe("/safe/path");
    expect(parsed.error.details.token).toBeUndefined();
    expect(parsed.error.details.cookie).toBeUndefined();
  });
});
