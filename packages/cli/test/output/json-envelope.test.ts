import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  exitCodeForError,
  serializeEnvelope,
  successEnvelope,
  failureEnvelope,
  CLI_SCHEMA_VERSION,
  type RenderedCliResult,
} from "../../src/output/envelope.ts";
import { classifyTerminalCause } from "../../src/cli/entry.ts";
import { runPluginStatus } from "../../src/commands/plugin-status.ts";
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

  test("available mutation commands validate required arguments without side effects", async () => {
    const captured = await captureCli(["--json", "plugin", "disable"]);
    expect(captured.exitCode).toBe(2);
    const parsed = assertSingleJsonValue(captured.stdout) as {
      ok: boolean;
      operation: string;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.operation).toBe("plugin.disable");
    expect(parsed.error.code).toBe("usage.missing-argument");
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

  test("unknown exceptions preserve the canonical operation and expose fixed public data", async () => {
    const secret = "SUPER_SECRET_INTERNAL_EXCEPTION_CANARY";
    const env = new Proxy(
      { ...process.env, HOME: "/tmp/explodex-cli-internal-failure" },
      {
        get(target, property, receiver) {
          if (property === "PWD") throw new Error(`private failure: ${secret}`);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const captured = await captureCli(["--json", "plugin", "validate"], env);
    expect(captured.exitCode).toBe(1);
    const parsed = assertSingleJsonValue(captured.stdout) as {
      operation: string;
      error: {
        code: string;
        message: string;
        details: Record<string, unknown>;
      };
    };
    expect(parsed.operation).toBe("plugin.validate");
    expect(parsed.error.code).toBe("operation.internal");
    expect(parsed.error.message).toBe("An unexpected internal error occurred.");
    expect(parsed.error.details).toEqual({ stage: "dispatch" });
    expect(captured.stdout).not.toContain(secret);
    expect(captured.stderr).not.toContain(secret);
  });

  test("raw Error details never serialize private messages", () => {
    const secret = "RAW_ERROR_SECRET_CANARY";
    const envelope = failureEnvelope("plugin.status", {
      code: "operation.internal",
      message: "An unexpected internal error occurred.",
      details: {
        cause: new Error(secret),
      },
    });
    const serialized = serializeEnvelope(envelope);
    expect(serialized).not.toContain(secret);
    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: 1,
      ok: false,
      operation: "plugin.status",
      error: {
        code: "operation.internal",
        message: "An unexpected internal error occurred.",
        details: {
          cause: {
            name: "Error",
          },
        },
      },
      warnings: [],
    });
  });

  test("late signals preserve operation-authored terminal truth", () => {
    const rendered: RenderedCliResult = {
      envelope: failureEnvelope("plugin.install", {
        code: "plugin.state.lock-failed",
        message: "Lock cleanup failed after the artifact commit.",
        details: {
          artifactCommitted: true,
          completedMutation: {
            id: "example",
            artifactCommitted: true,
            stateCommitted: false,
          },
          residualLockAuthority: { lockPath: "/isolated/plugins.lock" },
        },
      }),
      exitCode: 4,
      humanStdout: "",
      humanStderr: "Lock cleanup failed.\n",
    };
    expect(classifyTerminalCause({
      rendered,
      terminalCause: "interrupted",
      operation: "plugin.install",
      boundMs: 60_000,
    })).toBe(rendered);

    const cleanupFailure: RenderedCliResult = {
      envelope: failureEnvelope("plugin.review", {
        code: "cleanup_failed",
        message: "Review cleanup retained residual runtime authority.",
        details: {
          residualInventory: {
            callbacks: ["review-callback"],
            sessions: [],
          },
        },
      }),
      exitCode: 1,
      humanStdout: "",
      humanStderr: "Review cleanup failed.\n",
    };
    expect(classifyTerminalCause({
      rendered: cleanupFailure,
      terminalCause: "timeout",
      operation: "plugin.review",
      boundMs: 60_000,
    })).toBe(cleanupFailure);

    const completed: RenderedCliResult = {
      envelope: successEnvelope("plugin.install", {
        artifactCommitted: true,
        stateCommitted: true,
        outcome: "installed-pending",
      }),
      exitCode: 0,
      humanStdout: "Installed plugin.\n",
      humanStderr: "",
    };
    expect(classifyTerminalCause({
      rendered: completed,
      terminalCause: "interrupted",
      operation: "plugin.install",
      boundMs: 60_000,
    })).toBe(completed);
  });

  test("pre-aborted plugin status stops before state I/O", async () => {
    const controller = new AbortController();
    controller.abort();
    const rendered = await runPluginStatus({
      globals: {
        help: false,
        version: false,
        json: true,
        home: "/path/that-must-not-be-read",
        devRoot: null,
        timeoutMs: 60_000,
        timeoutRaw: null,
        noColor: true,
      },
      env: {},
      rest: [],
      endOfOptions: [],
      signal: controller.signal,
    });
    expect(rendered.envelope.ok).toBe(false);
    if (rendered.envelope.ok) throw new Error("expected interruption");
    expect(rendered.envelope.error.code).toBe("operation.interrupted");
  });

  test("timeout and interruption produce one classified terminal envelope", async () => {
    const fixture = await createStalledConfigWorkspace();
    try {
      const env = {
        ...process.env,
        HOME: join(fixture, ".home"),
        PWD: fixture,
      };
      const timeout = await captureCli(
        ["--json", "--timeout", "1ms", "plugin", "validate"],
        env,
      );
      expect(timeout.exitCode).toBe(5);
      const timeoutJson = assertSingleJsonValue(timeout.stdout) as {
        operation: string;
        error: { code: string; details: { boundMs: number; signal: string | null } };
      };
      expect(timeoutJson.operation).toBe("plugin.validate");
      expect(timeoutJson.error.code).toBe("operation.timeout");
      expect(timeoutJson.error.details.boundMs).toBe(1);
      expect(timeoutJson.error.details.signal).not.toBeUndefined();

      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const interrupted = captureCli(
          ["--json", "plugin", "validate"],
          env,
        );
        setTimeout(() => process.emit(signal), 10);
        const captured = await interrupted;
        expect(captured.exitCode).toBe(130);
        const parsed = assertSingleJsonValue(captured.stdout) as {
          operation: string;
          error: { code: string; details: { signal: string | null } };
        };
        expect(parsed.operation).toBe("plugin.validate");
        expect(parsed.error.code).toBe("operation.interrupted");
        expect(parsed.error.details.signal).not.toBeUndefined();
      }
    } finally {
      await rm(dirname(fixture), { recursive: true, force: true });
    }
  });
});

async function createStalledConfigWorkspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "explodex-cli-stalled-"));
  const workspace = join(parent, "explodex-plugin-stalled");
  await mkdir(join(workspace, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(workspace, "package.json"), `${JSON.stringify({
      name: "explodex-plugin-stalled",
      version: "0.0.0",
      private: true,
      peerDependencies: {
        "@explodex/sdk": "^1.2.0",
      },
    }, null, 2)}\n`),
    writeFile(
      join(workspace, "explodex.config.ts"),
      "await new Promise(() => {});\nexport default {};\n",
    ),
    writeFile(join(workspace, "src", "index.ts"), "export default {};\n"),
    writeFile(join(workspace, "README.md"), "# stalled\n"),
    writeFile(join(workspace, "tsconfig.json"), "{}\n"),
  ]);
  return workspace;
}
