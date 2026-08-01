import { describe, expect, test } from "bun:test";
import { resolveOperationBoundMs } from "../../src/cli/entry.ts";
import { devProveCommandForRoot } from "../../src/commands/dev-prove.ts";

describe("development proof CLI contract", () => {
  test("defaults proof to ten minutes while preserving explicit and unrelated bounds", () => {
    expect(resolveOperationBoundMs({
      operation: "dev.prove",
      timeoutMs: 60_000,
      timeoutRaw: null,
    })).toBe(600_000);
    expect(resolveOperationBoundMs({
      operation: "dev.prove",
      timeoutMs: 90_000,
      timeoutRaw: "90s",
    })).toBe(90_000);
    expect(resolveOperationBoundMs({
      operation: "dev.ensure",
      timeoutMs: 60_000,
      timeoutRaw: null,
    })).toBe(60_000);
  });

  test("preserves an explicit root in proof and ensure guidance", () => {
    const selection = {
      explicit: true,
      rootPath: "/private/tmp/Explodex proof root",
    };
    expect(devProveCommandForRoot(selection, "prove")).toBe(
      'explodex --timeout 10m --dev-root "/private/tmp/Explodex proof root" dev prove',
    );
    expect(devProveCommandForRoot(selection, "ensure")).toBe(
      'explodex --dev-root "/private/tmp/Explodex proof root" dev ensure',
    );
  });
});
