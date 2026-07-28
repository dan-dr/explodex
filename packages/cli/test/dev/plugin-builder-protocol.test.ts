import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createDevInteractiveAuthBlockerDetails,
} from "../../src/dev/auth.ts";
import type { TargetIdentity } from "../../src/cdp/types.ts";

const ROOT = join(import.meta.dir, "../../../..");
const INTERPRETER = join(
  ROOT,
  "skills/explodex-plugin-builder/scripts/interpret-cli.mjs",
);
const TARGET: TargetIdentity = {
  role: "development",
  pid: 4242,
  processStartedAt: "2026-07-28T00:00:00.000001Z",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  appVersion: "26.721.41059",
  appBuild: "5848",
  port: 9444,
  browserIdentity: "Chrome/ChatGPT",
  targetId: "target-dev",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 17,
  executionContextUniqueId: "context-dev",
  frameId: "frame-dev",
};
const PLUGIN = {
  id: "sample",
  version: "dev-1",
  payloadSha256: "a".repeat(64),
};
const SDK = {
  version: "1.2.0",
  sha256: "b".repeat(64),
};

async function interpret(options: {
  protocol: "one-shot" | "develop";
  operation?: string;
  operationId?: string;
  stdout: string;
}) {
  const args = [
    "node",
    INTERPRETER,
    "--protocol",
    options.protocol,
    ...(options.operation === undefined
      ? []
      : ["--operation", options.operation]),
    ...(options.operationId === undefined
      ? []
      : ["--operation-id", options.operationId]),
  ];
  const child = Bun.spawn(args, {
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(options.stdout);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    parsed: stdout.length === 0
      ? null
      : JSON.parse(stdout) as Record<string, unknown>,
  };
}

function validDevelopRecords() {
  return [
    {
      schemaVersion: 1,
      operationId: "develop-op",
      sequence: 1,
      generation: 0,
      type: "watch-ready",
      sdkRuntimeIdentity: SDK,
      target: TARGET,
    },
    {
      schemaVersion: 1,
      operationId: "develop-op",
      sequence: 2,
      generation: 1,
      type: "build-started",
    },
    {
      schemaVersion: 1,
      operationId: "develop-op",
      sequence: 3,
      generation: 1,
      type: "build-succeeded",
      pluginIdentity: PLUGIN,
      sdkRuntimeIdentity: SDK,
    },
    {
      schemaVersion: 1,
      operationId: "develop-op",
      sequence: 4,
      generation: 1,
      type: "apply-started",
      pluginIdentity: PLUGIN,
      sdkRuntimeIdentity: SDK,
      target: TARGET,
    },
    {
      schemaVersion: 1,
      operationId: "develop-op",
      sequence: 5,
      generation: 1,
      type: "apply-succeeded",
      pluginIdentity: PLUGIN,
      sdkRuntimeIdentity: SDK,
      target: TARGET,
      details: { appliedAt: "2026-07-28T00:00:01.000Z" },
    },
    {
      schemaVersion: 1,
      operationId: "develop-op",
      type: "terminal",
      ok: true,
      reason: "completed",
      lastSequence: 5,
      lastGood: {
        generation: 1,
        pluginIdentity: PLUGIN,
        sdkRuntimeIdentity: SDK,
        target: TARGET,
        appliedAt: "2026-07-28T00:00:01.000Z",
      },
    },
  ];
}

function jsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("M4-F07 plugin-builder machine protocol interpreter", () => {
  test("ships the interpreter and mandatory public-operation blocker workflow", async () => {
    const skill = await readFile(
      join(ROOT, "skills/explodex-plugin-builder/SKILL.md"),
      "utf8",
    );
    const mandatory = skill.split(
      "## V1 public CLI machine protocol (mandatory)",
    )[1];
    expect(mandatory).toBeDefined();
    expect(mandatory).toContain("scripts/interpret-cli.mjs");
    expect(mandatory).toContain("explodex --json dev status");
    expect(mandatory).toContain("explodex --json dev recover");
    expect(mandatory).toContain("new public operation");
    expect(mandatory).not.toContain("bun run inject");
    expect(mandatory).not.toContain("scripts/cdp-inject");
    expect(mandatory).toContain("Do not invoke repository injectors");
    expect(skill).not.toContain("create under `plugins/<id>/`");
    expect(skill).toContain(
      "Do not use `plugins/<id>/`, `sdk/explodex-sdk.js`, `scripts/cdp-inject.ts`,",
    );
  });

  test("validates exact one-shot envelope operation and identities", async () => {
    const result = await interpret({
      protocol: "one-shot",
      operation: "dev.status",
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        operation: "dev.status",
        result: {
          rootPath: "/private/tmp/explodex-auth/dev/plugin-dev",
          identity: {
            pid: TARGET.pid,
            processStartedAt: TARGET.processStartedAt,
            port: 9444,
          },
        },
        warnings: [],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({
      valid: true,
      protocol: "one-shot",
      operation: "dev.status",
      ok: true,
    });
  });

  test("rejects malformed, partial, and wrong-operation one-shot output", async () => {
    for (const stdout of [
      "{\"schemaVersion\":1",
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        operation: "dev.status",
        warnings: [],
      }),
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        operation: "dev.recover",
        result: {},
        warnings: [],
      }),
      `${JSON.stringify({
        schemaVersion: 1,
        ok: true,
        operation: "dev.status",
        result: {},
        warnings: [],
      })}\nprose`,
    ]) {
      const result = await interpret({
        protocol: "one-shot",
        operation: "dev.status",
        stdout,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("skill.protocol-mismatch");
      expect(result.stdout).toBe("");
    }
  });

  test("validates one-shot auth blockers and rejects identity-free mutation success", async () => {
    const auth = createDevInteractiveAuthBlockerDetails({
      rootPath: "/private/tmp/explodex-auth/dev/plugin-dev",
      target: TARGET,
    });
    const blocked = await interpret({
      protocol: "one-shot",
      operation: "plugin.review",
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: false,
        operation: "plugin.review",
        error: {
          code: "auth.required",
          message: "Sign-in required.",
          details: auth,
        },
        warnings: [],
      }),
    });
    expect(blocked.exitCode).toBe(0);
    expect(blocked.parsed).toMatchObject({
      blocker: { code: "auth.required" },
      question: {
        role: "development",
        verificationOperation: "dev.status",
        continuationOperation: "plugin.develop",
      },
    });

    const validInject = await interpret({
      protocol: "one-shot",
      operation: "dev.inject",
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        operation: "dev.inject",
        result: {
          identity: { ...PLUGIN, lifecycle: "dynamic" },
          target: TARGET,
          sourceDelivered: true,
        },
        warnings: [],
      }),
    });
    expect(validInject.exitCode).toBe(0);
    expect(validInject.parsed).toMatchObject({
      identity: {
        plugins: [PLUGIN],
        targets: [TARGET],
      },
    });

    const missingIdentity = await interpret({
      protocol: "one-shot",
      operation: "dev.inject",
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        operation: "dev.inject",
        result: { sourceDelivered: true },
        warnings: [],
      }),
    });
    expect(missingIdentity.exitCode).toBe(1);
    expect(missingIdentity.stderr).toContain(
      "requires an exact plugin identity",
    );
  });

  test("validates sequence, generation identity, terminal, and complete last-good", async () => {
    const result = await interpret({
      protocol: "develop",
      operationId: "develop-op",
      stdout: jsonl(validDevelopRecords()),
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({
      valid: true,
      protocol: "develop",
      operationId: "develop-op",
      ok: true,
      eventCount: 5,
    });
  });

  test("rejects stale/mismatched identities, sequence gaps, last-good drift, and post-terminal output", async () => {
    const mutations: Array<(records: Array<Record<string, unknown>>) => void> = [
      (records) => {
        records[1]!.sequence = 3;
      },
      (records) => {
        records[3]!.pluginIdentity = {
          ...PLUGIN,
          payloadSha256: "c".repeat(64),
        };
      },
      (records) => {
        const terminal = records.at(-1)!;
        terminal.lastGood = {
          ...(terminal.lastGood as Record<string, unknown>),
          generation: 2,
        };
      },
      (records) => {
        records.push({
          schemaVersion: 1,
          operationId: "develop-op",
          sequence: 6,
          generation: 2,
          type: "build-started",
        });
      },
      (records) => {
        records[2]!.operationId = "stale-operation";
      },
      (records) => {
        records[4]!.target = {
          ...TARGET,
          executionContextUniqueId: "changed-context",
        };
      },
    ];
    for (const mutate of mutations) {
      const records = structuredClone(validDevelopRecords()) as Array<
        Record<string, unknown>
      >;
      mutate(records);
      const result = await interpret({
        protocol: "develop",
        operationId: "develop-op",
        stdout: jsonl(records),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("skill.protocol-mismatch");
    }
  });

  test("rejects post-target-loss output and forged auth blocker details", async () => {
    const targetLost = [
      {
        schemaVersion: 1,
        operationId: "lost-op",
        sequence: 1,
        generation: 1,
        type: "target-lost",
        target: TARGET,
        details: { code: "cdp.target-lost" },
      },
      {
        schemaVersion: 1,
        operationId: "lost-op",
        sequence: 2,
        generation: 2,
        type: "build-started",
      },
      {
        schemaVersion: 1,
        operationId: "lost-op",
        type: "terminal",
        ok: false,
        reason: "blocked",
        lastSequence: 2,
        lastGood: null,
        error: {
          code: "cdp.target-lost",
          message: "Target lost.",
        },
      },
    ];
    const postLoss = await interpret({
      protocol: "develop",
      operationId: "lost-op",
      stdout: jsonl(targetLost),
    });
    expect(postLoss.exitCode).toBe(1);
    expect(postLoss.stderr).toContain("final nonterminal");

    const forgedAuth = await interpret({
      protocol: "one-shot",
      operation: "plugin.review",
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: false,
        operation: "plugin.review",
        warnings: [],
        error: {
          code: "auth.required",
          message: "Sign-in required.",
          details: {
            blocker: "authentication",
            authMode: "interactive",
            role: "development",
            target: { pid: 1, port: 9444 },
          },
        },
      }),
    });
    expect(forgedAuth.exitCode).toBe(1);
    expect(forgedAuth.stderr).toContain("auth.");
  });

  test("returns a focused auth question and requires a new public verification operation", async () => {
    const auth = createDevInteractiveAuthBlockerDetails({
      rootPath: "/private/tmp/explodex-auth/dev/plugin-dev",
      target: TARGET,
    });
    const records = [
      {
        schemaVersion: 1,
        operationId: "auth-op",
        sequence: 1,
        generation: 0,
        type: "blocked",
        details: { code: "auth.required", cause: auth },
      },
      {
        schemaVersion: 1,
        operationId: "auth-op",
        type: "terminal",
        ok: false,
        reason: "blocked",
        lastSequence: 1,
        lastGood: null,
        error: {
          code: "auth.required",
          message:
            "Authenticated renderer checks require one-time interactive sign-in.",
          details: auth,
        },
      },
    ];
    const result = await interpret({
      protocol: "develop",
      operationId: "auth-op",
      stdout: jsonl(records),
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({
      blocker: { code: "auth.required" },
      question: {
        code: "auth.required",
        role: "development",
        target: {
          pid: TARGET.pid,
          port: 9444,
          targetId: TARGET.targetId,
        },
        continuationOperation: "plugin.develop",
        verificationOperation: "dev.status",
        devRemainsRunning: true,
        mainRemainsRunning: true,
      },
    });
    expect(JSON.stringify(result.parsed)).not.toContain("password-canary");
  });

  test("rejects blocker output without its matching blocked terminal", async () => {
    const records = [
      {
        schemaVersion: 1,
        operationId: "blocked-op",
        sequence: 1,
        generation: 0,
        type: "blocked",
        details: { code: "auth.required" },
      },
      {
        schemaVersion: 1,
        operationId: "blocked-op",
        type: "terminal",
        ok: false,
        reason: "preflight-failed",
        lastSequence: 1,
        lastGood: null,
        error: {
          code: "auth.required",
          message: "Sign-in required.",
        },
      },
    ];
    const result = await interpret({
      protocol: "develop",
      stdout: jsonl(records),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocker event requires terminal reason blocked");
  });
});
