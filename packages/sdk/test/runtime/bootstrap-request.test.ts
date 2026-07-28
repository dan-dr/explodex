import { describe, expect, test } from "bun:test";
import { installRuntime } from "../../src/runtime/bootstrap.ts";

describe("M4-F03 operation request adoption", () => {
  test("compatible runtime adopts a new operation request without teardown", () => {
    const digest = "a".repeat(64);
    const host = {
      console,
      setTimeout,
      clearTimeout,
      __explodexSdkRuntimeRequestIdentity: `${digest}:operation-1`,
    } as unknown as Parameters<typeof installRuntime>[0] & Record<
      string,
      unknown
    >;
    const first = installRuntime(host);
    const adopted = (
      first as unknown as Record<string, (value: string) => boolean>
    )["__explodexAdoptRuntimeRequest"]!(`${digest}:operation-2`);
    expect(adopted).toBe(true);
    expect(
      (first as unknown as Record<string, unknown>)[
        "__explodexSdkRuntimeRequestMark"
      ],
    ).toBe(`${digest}:operation-2`);
    expect(installRuntime(host)).toBe(first);
  });

  test("runtime refuses a request for different SDK bytes", () => {
    const digest = "a".repeat(64);
    const host = {
      console,
      setTimeout,
      clearTimeout,
      __explodexSdkRuntimeRequestIdentity: `${digest}:operation-1`,
    } as unknown as Parameters<typeof installRuntime>[0] & Record<
      string,
      unknown
    >;
    const runtime = installRuntime(host);
    expect((
      runtime as unknown as Record<string, (value: string) => boolean>
    )["__explodexAdoptRuntimeRequest"]!(`${"b".repeat(64)}:operation-2`))
      .toBe(false);
  });

  test("adoption renews a consumed reconciliation capability for a later operation", async () => {
    const digest = "a".repeat(64);
    const host = {
      console,
      setTimeout,
      clearTimeout,
      __explodexSdkRuntimeRequestIdentity: `${digest}:operation-1`,
    } as unknown as Parameters<typeof installRuntime>[0] & Record<
      string,
      unknown
    >;
    const runtime = installRuntime(host) as unknown as Record<string, unknown>;
    const reconcile = () =>
      runtime["__explodexReconcileEnabledPayload"] as (
        input: unknown,
        evaluate: unknown,
      ) => Promise<{ error?: { code: string } }>;
    const input = (operationId: string) => ({
      schemaVersion: 1,
      operationId,
      nonce: `${operationId}-nonce`,
      id: "sample",
      version: "1.0.0",
      payloadSha256: "b".repeat(64),
      lifecycle: "dynamic",
      boundary: "current",
      assets: [],
    });
    const first = await reconcile()(input("operation-1"), () => undefined);
    expect(first.error?.code).not.toBe("plugin.application.unauthorized");
    const adopt = runtime["__explodexAdoptRuntimeRequest"] as (
      value: string,
    ) => boolean;
    expect(adopt(`${digest}:operation-2`)).toBe(true);
    const second = await reconcile()(input("operation-2"), () => undefined);
    expect(second.error?.code).not.toBe("plugin.application.unauthorized");
  });
});
