import { afterEach, describe, expect, test } from "bun:test";
import {
  createNodeCdpAdapter,
  type CdpAdapter,
  type CdpTarget,
} from "../../src/cdp/index.ts";

const OriginalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];
  static closeDelayMs = 0;
  /** "success" closes; "reject" fires error; "hang" never reaches CLOSED. */
  static closeMode: "success" | "reject" | "hang" = "success";
  static omitContextUniqueId = false;
  static evaluateMode:
    | "success"
    | "exception"
    | "malformed"
    | "missing-value"
    | "object"
    | "bogus-type"
    | "wrong-string-value" = "success";

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== "string") throw new Error("fixture accepts only string websocket messages");
    const request = JSON.parse(data) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    this.sent.push(request);
    if (request.method === "Runtime.enable") {
      const context: Record<string, unknown> = {
        id: 17,
        origin: "app://-",
        name: "",
        auxData: {
          isDefault: true,
          frameId: "FRAME-17",
        },
      };
      if (!FakeWebSocket.omitContextUniqueId) context.uniqueId = "unique-context-17";
      this.emitMessage({
        method: "Runtime.executionContextCreated",
        params: { context },
      });
      this.emitMessage({ id: request.id, result: {} });
      return;
    }
    if (request.method === "Runtime.evaluate") {
      if (FakeWebSocket.evaluateMode === "exception") {
        this.emitMessage({
          id: request.id,
          result: {
            result: { type: "undefined" },
            exceptionDetails: { text: "fixture exception" },
          },
        });
        return;
      }
      if (FakeWebSocket.evaluateMode === "malformed") {
        this.emitMessage({ id: request.id, result: { unexpected: true } });
        return;
      }
      if (FakeWebSocket.evaluateMode === "missing-value") {
        this.emitMessage({ id: request.id, result: { result: { type: "string" } } });
        return;
      }
      if (FakeWebSocket.evaluateMode === "object") {
        this.emitMessage({
          id: request.id,
          result: { result: { type: "object", objectId: "OBJECT-1" } },
        });
        return;
      }
      if (FakeWebSocket.evaluateMode === "bogus-type") {
        this.emitMessage({ id: request.id, result: { result: { type: "bogus", value: "ok" } } });
        return;
      }
      if (FakeWebSocket.evaluateMode === "wrong-string-value") {
        this.emitMessage({ id: request.id, result: { result: { type: "string", value: 7 } } });
        return;
      }
      this.emitMessage({
        id: request.id,
        result: {
          result: { type: "string", value: "ok" },
        },
      });
      return;
    }
    this.emitMessage({ id: request.id, result: {} });
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED || this.readyState === FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
    if (FakeWebSocket.closeMode === "hang") {
      // Never reach CLOSED; production close must time out truthfully.
      return;
    }
    if (FakeWebSocket.closeMode === "reject") {
      setTimeout(() => {
        this.dispatchEvent(new Event("error"));
      }, FakeWebSocket.closeDelayMs);
      return;
    }
    setTimeout(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "fixture" }));
    }, FakeWebSocket.closeDelayMs);
  }

  private emitMessage(payload: unknown): void {
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    });
  }
}

afterEach(() => {
  globalThis.fetch = OriginalFetch;
  globalThis.WebSocket = OriginalWebSocket;
  FakeWebSocket.instances = [];
  FakeWebSocket.closeDelayMs = 0;
  FakeWebSocket.closeMode = "success";
  FakeWebSocket.omitContextUniqueId = false;
  FakeWebSocket.evaluateMode = "success";
});

function installProductionAdapterFixture(): CdpAdapter {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/json/version")) {
      return new Response(JSON.stringify({
        Browser: "Chrome/150.0.7871.124",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/browser/BROWSER-1",
        pid: 4200,
      }));
    }
    if (url.endsWith("/json/list")) {
      return new Response(JSON.stringify([{
        id: "PAGE-1",
        type: "page",
        url: "app://-/index.html",
        title: "ChatGPT",
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/PAGE-1",
      }]));
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return createNodeCdpAdapter();
}

async function openSession(adapter: CdpAdapter) {
  const targets = await adapter.listTargets({ host: "127.0.0.1", port: 9444 });
  const target = targets[0];
  if (target === undefined) throw new Error("fixture target unavailable");
  return adapter.openTargetSession({ host: "127.0.0.1", port: 9444, target });
}

describe("production CDP adapter", () => {
  test("binds the websocket to the selected page and preserves frame/context identities", async () => {
    const session = await openSession(installProductionAdapterFixture());
    const contexts = await session.listExecutionContexts({});

    expect(session.targetId).toBe("PAGE-1");
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "ws://127.0.0.1:9444/devtools/page/PAGE-1",
    );
    expect(contexts).toEqual([{
      id: 17,
      uniqueId: "unique-context-17",
      targetId: "PAGE-1",
      frameId: "FRAME-17",
      isDefault: true,
      origin: "app://-",
      name: "",
    }]);

    await session.close({ timeoutMs: 100 });
  });

  test("rejects a target websocket URL that names a different target", async () => {
    const adapter = installProductionAdapterFixture();
    await expect(adapter.openTargetSession({
      host: "127.0.0.1",
      port: 9444,
      target: {
        id: "PAGE-A",
        type: "page",
        url: "app://-/index.html",
        title: "ChatGPT",
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/PAGE-B",
      },
    })).rejects.toThrow("did not match selected target PAGE-A");
    expect(FakeWebSocket.instances).toEqual([]);
  });

  test("evaluates with the exact execution-context uniqueId", async () => {
    const session = await openSession(installProductionAdapterFixture());
    const [selected] = await session.listExecutionContexts({});
    if (selected === undefined) throw new Error("fixture context unavailable");

    await expect(session.evaluate({
      executionContextId: selected.id,
      executionContextUniqueId: selected.uniqueId,
      expression: "globalThis.fixture",
    })).resolves.toEqual({ value: "ok" });

    const evaluate = FakeWebSocket.instances[0]?.sent.find(
      (request) => request.method === "Runtime.evaluate",
    );
    expect(evaluate?.params).toMatchObject({
      uniqueContextId: "unique-context-17",
      returnByValue: true,
      awaitPromise: true,
    });
    expect(evaluate?.params).not.toHaveProperty("contextId");

    await session.close({ timeoutMs: 100 });
  });

  test("rejects missing unique execution-context identity", async () => {
    FakeWebSocket.omitContextUniqueId = true;
    const session = await openSession(installProductionAdapterFixture());

    await expect(session.listExecutionContexts({})).rejects.toThrow("uniqueId");
    await session.close({ timeoutMs: 100 });
  });

  test.each([
    "exception",
    "malformed",
    "missing-value",
    "object",
    "bogus-type",
    "wrong-string-value",
  ] as const)(
    "rejects %s Runtime.evaluate responses",
    async (mode) => {
      FakeWebSocket.evaluateMode = mode;
      const session = await openSession(installProductionAdapterFixture());
      const [selected] = await session.listExecutionContexts({});
      if (selected === undefined) throw new Error("fixture context unavailable");

      const expectedMessage = mode === "exception"
        ? "exceptionDetails"
        : mode === "malformed"
          ? "malformed"
          : mode === "missing-value"
            ? "omitted value"
            : mode === "object"
              ? "unsupported remote result"
              : mode === "bogus-type"
                ? "unsupported remote type"
                : "non-string value";
      await expect(session.evaluate({
        executionContextId: selected.id,
        executionContextUniqueId: selected.uniqueId,
        expression: "globalThis.fixture",
      })).rejects.toThrow(expectedMessage);

      await session.close({ timeoutMs: 100 });
    },
  );

  test("concurrent sessions keep overlapping request IDs and responses socket-local", async () => {
    const adapter = installProductionAdapterFixture();
    const target = (id: string): CdpTarget => ({
      id,
      type: "page",
      url: "app://-/index.html",
      title: id,
      webSocketDebuggerUrl: `ws://127.0.0.1:9444/devtools/page/${id}`,
    });
    const [first, second] = await Promise.all([
      adapter.openTargetSession({ host: "127.0.0.1", port: 9444, target: target("PAGE-A") }),
      adapter.openTargetSession({ host: "127.0.0.1", port: 9444, target: target("PAGE-B") }),
    ]);

    const [firstContexts, secondContexts] = await Promise.all([
      first.listExecutionContexts({}),
      second.listExecutionContexts({}),
    ]);
    const firstContext = firstContexts[0];
    const secondContext = secondContexts[0];
    if (firstContext === undefined || secondContext === undefined) {
      throw new Error("fixture contexts unavailable");
    }
    const [firstResult, secondResult] = await Promise.all([
      first.evaluate({
        executionContextId: firstContext.id,
        executionContextUniqueId: firstContext.uniqueId,
        expression: "first",
      }),
      second.evaluate({
        executionContextId: secondContext.id,
        executionContextUniqueId: secondContext.uniqueId,
        expression: "second",
      }),
    ]);

    expect(firstResult).toEqual({ value: "ok" });
    expect(secondResult).toEqual({ value: "ok" });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances.map((socket) => socket.sent.map((request) => request.id))).toEqual([
      [1, 2],
      [1, 2],
    ]);

    await Promise.all([first.close({ timeoutMs: 100 }), second.close({ timeoutMs: 100 })]);
  });

  test("close waits for websocket closure within its bound", async () => {
    FakeWebSocket.closeDelayMs = 25;
    const session = await openSession(installProductionAdapterFixture());
    const started = Date.now();

    await session.close({ timeoutMs: 200 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("close reports a bounded timeout instead of returning while the socket is open", async () => {
    FakeWebSocket.closeDelayMs = 200;
    const session = await openSession(installProductionAdapterFixture());
    const started = Date.now();

    await expect(session.close({ timeoutMs: 20 })).rejects.toMatchObject({
      code: "cdp_session_close_timeout",
      boundMs: 20,
    });
    expect(Date.now() - started).toBeLessThan(150);
  });

  test("M1-F03R: closes the session when onSessionOpened registration throws", async () => {
    const adapter = installProductionAdapterFixture();
    const targets = await adapter.listTargets({ host: "127.0.0.1", port: 9444 });
    const target = targets[0];
    if (target === undefined) throw new Error("fixture target unavailable");

    await expect(adapter.openTargetSession({
      host: "127.0.0.1",
      port: 9444,
      target,
      onSessionOpened() {
        throw new Error("registration callback failed");
      },
    })).rejects.toThrow("registration callback failed");

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    // Wait for the adapter's bounded close to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("M1-F03R: registration close timeout surfaces residual session authority", async () => {
    FakeWebSocket.closeMode = "hang";
    const adapter = installProductionAdapterFixture();
    const targets = await adapter.listTargets({ host: "127.0.0.1", port: 9444 });
    const target = targets[0];
    if (target === undefined) throw new Error("fixture target unavailable");

    let thrown: unknown;
    try {
      await adapter.openTargetSession({
        host: "127.0.0.1",
        port: 9444,
        target,
        onSessionOpened() {
          throw new Error("registration callback failed");
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "cdp_session_registration_cleanup_failed",
      boundMs: 250,
    });
    const residual = (thrown as {
      residual: {
        targetId: string;
        isOpen(): boolean;
        dispose(options?: { timeoutMs?: number }): Promise<void>;
      };
      cleanupError: unknown;
      registrationError: unknown;
    }).residual;
    expect(residual.targetId).toBe("PAGE-1");
    expect(residual.isOpen()).toBe(true);
    expect(String((thrown as { cleanupError: unknown }).cleanupError)).toMatch(
      /cdp_session_close_timeout|timed out/i,
    );
    expect(String((thrown as { registrationError: unknown }).registrationError)).toMatch(
      /registration callback failed/,
    );
    // Socket never reached CLOSED; residual remains reachable for dispose/retry.
    expect(FakeWebSocket.instances[0]?.readyState).not.toBe(FakeWebSocket.CLOSED);
  });

  test("M1-F03R: registration close rejection surfaces residual session authority", async () => {
    FakeWebSocket.closeMode = "reject";
    FakeWebSocket.closeDelayMs = 5;
    const adapter = installProductionAdapterFixture();
    const targets = await adapter.listTargets({ host: "127.0.0.1", port: 9444 });
    const target = targets[0];
    if (target === undefined) throw new Error("fixture target unavailable");

    let thrown: unknown;
    try {
      await adapter.openTargetSession({
        host: "127.0.0.1",
        port: 9444,
        target,
        onSessionOpened() {
          throw new Error("registration callback failed");
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "cdp_session_registration_cleanup_failed",
    });
    const residual = (thrown as {
      residual: { targetId: string; isOpen(): boolean };
      cleanupError: unknown;
    }).residual;
    expect(residual.targetId).toBe("PAGE-1");
    expect(residual.isOpen()).toBe(true);
    expect(String((thrown as { cleanupError: unknown }).cleanupError)).toMatch(
      /failed while closing/i,
    );
  });
});
