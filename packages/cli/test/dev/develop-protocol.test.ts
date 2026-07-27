import { describe, expect, test } from "bun:test";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  DevelopProtocolWriter,
  type DevelopLastGood,
} from "../../src/dev/develop-protocol.ts";

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

const LAST_GOOD: DevelopLastGood = {
  generation: 1,
  pluginIdentity: {
    id: "sample",
    version: "dev-1",
    payloadSha256: "a".repeat(64),
  },
  sdkRuntimeIdentity: {
    version: "1.2.0",
    sha256: "b".repeat(64),
  },
  target: TARGET,
  appliedAt: "2026-07-28T00:00:01.000Z",
};

describe("M4-F04 develop JSONL protocol", () => {
  test("uses one operation ID, strict sequence order, and exact last-good promotion", () => {
    const lines: string[] = [];
    const writer = new DevelopProtocolWriter({
      operationId: "develop-op",
      writeLine: (line) => lines.push(line),
    });

    writer.event({ generation: 0, type: "watch-ready" });
    writer.event({ generation: 1, type: "build-started" });
    writer.event({
      generation: 1,
      type: "build-succeeded",
      pluginIdentity: LAST_GOOD.pluginIdentity,
      sdkRuntimeIdentity: LAST_GOOD.sdkRuntimeIdentity,
    });
    writer.event({
      generation: 1,
      type: "apply-started",
      pluginIdentity: LAST_GOOD.pluginIdentity,
      sdkRuntimeIdentity: LAST_GOOD.sdkRuntimeIdentity,
      target: TARGET,
    });
    writer.applySucceeded(LAST_GOOD);
    writer.terminal({ ok: true, reason: "completed" });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(6);
    expect(parsed.slice(0, -1).map((record) => record.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(new Set(parsed.map((record) => record.operationId))).toEqual(
      new Set(["develop-op"]),
    );
    expect(parsed.at(-1)).toEqual({
      schemaVersion: 1,
      operationId: "develop-op",
      type: "terminal",
      ok: true,
      reason: "completed",
      lastSequence: 5,
      lastGood: LAST_GOOD,
    });
    expect(parsed.at(-1)).not.toHaveProperty("sequence");
  });

  test("preflight failure has no event and a zero-sequence terminal", () => {
    const lines: string[] = [];
    const writer = new DevelopProtocolWriter({
      operationId: "preflight-op",
      writeLine: (line) => lines.push(line),
    });
    writer.terminal({
      ok: false,
      reason: "preflight-failed",
      error: {
        code: "develop.preflight-failed",
        message: "Workspace is unsafe.",
      },
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      schemaVersion: 1,
      operationId: "preflight-op",
      type: "terminal",
      ok: false,
      reason: "preflight-failed",
      lastSequence: 0,
      lastGood: null,
      error: {
        code: "develop.preflight-failed",
        message: "Workspace is unsafe.",
      },
    });
  });

  test("target loss is the final event and blocks exactly once", () => {
    const lines: string[] = [];
    const writer = new DevelopProtocolWriter({
      operationId: "target-op",
      writeLine: (line) => lines.push(line),
    });
    writer.event({ generation: 0, type: "watch-ready" });
    writer.applySucceeded(LAST_GOOD);
    writer.event({
      generation: 2,
      type: "target-lost",
      target: TARGET,
      details: { code: "cdp.target-lost" },
    });
    writer.terminal({
      ok: false,
      reason: "blocked",
      error: {
        code: "cdp.target-lost",
        message: "The exact development target was lost.",
      },
    });
    expect(() =>
      writer.event({ generation: 3, type: "build-started" })
    ).toThrow("terminal");

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.at(-2)?.type).toBe("target-lost");
    expect(parsed.at(-1)).toMatchObject({
      type: "terminal",
      reason: "blocked",
      lastSequence: 3,
      lastGood: LAST_GOOD,
      error: { code: "cdp.target-lost" },
    });
    expect(parsed.filter((record) => record.type === "terminal")).toHaveLength(1);
  });
});
