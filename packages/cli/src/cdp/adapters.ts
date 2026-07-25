import type { DeclaredPort, LoopbackHost } from "../host/status.ts";
import type {
  CdpEndpointVersion,
  CdpExecutionContext,
  CdpTarget,
} from "./types.ts";

export type CdpEvaluationResult = {
  value: unknown;
};

export type CdpTargetSession = {
  targetId: string;
  listExecutionContexts(options: { signal?: AbortSignal }): Promise<CdpExecutionContext[]>;
  evaluate(input: {
    executionContextId: number;
    executionContextUniqueId: string;
    expression: string;
    signal?: AbortSignal;
  }): Promise<CdpEvaluationResult>;
  close(options?: { timeoutMs?: number }): Promise<void>;
};

export type CdpAdapter = {
  readEndpoint(input: {
    host: LoopbackHost;
    port: DeclaredPort;
    signal?: AbortSignal;
  }): Promise<CdpEndpointVersion>;
  listTargets(input: {
    host: LoopbackHost;
    port: DeclaredPort;
    signal?: AbortSignal;
  }): Promise<CdpTarget[]>;
  openTargetSession(input: {
    host: LoopbackHost;
    port: DeclaredPort;
    target: CdpTarget;
    signal?: AbortSignal;
    onSessionOpened?(session: CdpTargetSession): void;
  }): Promise<CdpTargetSession>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CDP response field ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPid(record: Record<string, unknown>): number | undefined {
  const candidates = [record["Pid"], record["pid"], record["ProcessId"], record["processId"]];
  const found = candidates.find((value) => Number.isInteger(value) && Number(value) > 0);
  return found === undefined ? undefined : Number(found);
}

function validateWebSocketUrl(url: string, host: LoopbackHost, port: DeclaredPort): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("CDP websocket URL must use ws or wss");
  }
  if (parsed.hostname !== host || Number(parsed.port) !== port) {
    throw new Error(`CDP websocket URL escaped declared endpoint ${host}:${port}`);
  }
  return parsed;
}

function validateTargetWebSocketUrl(
  url: string,
  host: LoopbackHost,
  port: DeclaredPort,
  targetId: string,
): void {
  const parsed = validateWebSocketUrl(url, host, port);
  const expectedPath = `/devtools/page/${encodeURIComponent(targetId)}`;
  if (parsed.pathname !== expectedPath || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`CDP target websocket URL did not match selected target ${targetId}`);
  }
}

async function readJson(input: {
  host: LoopbackHost;
  port: DeclaredPort;
  path: "/json/version" | "/json/list";
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(`http://${input.host}:${input.port}${input.path}`, {
    signal: input.signal,
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`CDP ${input.path} returned HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

class NodeCdpTargetSession implements CdpTargetSession {
  readonly targetId: string;
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
  }>();
  private readonly contexts = new Map<number, CdpExecutionContext>();
  private nextId = 1;
  private closed = false;
  private contextError: Error | null = null;

  private constructor(targetId: string, socket: WebSocket) {
    this.targetId = targetId;
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        this.onMessage(event.data);
      } catch (error: unknown) {
        this.contextError = error instanceof Error ? error : new Error("Malformed CDP context event");
      }
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("CDP target session closed"));
      }
      this.pending.clear();
    });
    socket.addEventListener("error", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error("CDP target session failed"));
      }
      this.pending.clear();
    });
  }

  static async connect(input: {
    targetId: string;
    webSocketDebuggerUrl: string;
    signal?: AbortSignal;
  }): Promise<NodeCdpTargetSession> {
    const socket = new WebSocket(input.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        socket.close();
        reject(Object.assign(new Error("CDP websocket connection aborted"), { code: "ABORT_ERR" }));
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("CDP websocket connection failed"));
      };
      const cleanup = (): void => {
        input.signal?.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    return new NodeCdpTargetSession(input.targetId, socket);
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const id = parsed["id"];
    if (Number.isInteger(id)) {
      const waiter = this.pending.get(Number(id));
      if (waiter === undefined) return;
      this.pending.delete(Number(id));
      if ("error" in parsed) waiter.reject(new Error(JSON.stringify(parsed["error"])));
      else waiter.resolve(parsed["result"]);
      return;
    }
    const method = parsed["method"];
    if (method !== "Runtime.executionContextCreated") return;
    const params = parsed["params"];
    if (!isRecord(params) || !isRecord(params["context"])) return;
    const contextRecord = params["context"];
    const contextId = contextRecord["id"];
    const uniqueId = contextRecord["uniqueId"];
    const auxData = isRecord(contextRecord["auxData"]) ? contextRecord["auxData"] : {};
    const frameId = auxData["frameId"];
    if (!Number.isInteger(contextId)) return;
    if (typeof uniqueId !== "string" || uniqueId.length === 0) {
      throw new Error("CDP execution context uniqueId must be a non-empty string");
    }
    if (typeof frameId !== "string" || frameId.length === 0) {
      throw new Error("CDP execution context frameId must be a non-empty string");
    }
    this.contexts.set(Number(contextId), {
      id: Number(contextId),
      uniqueId,
      targetId: this.targetId,
      frameId,
      isDefault: auxData["isDefault"] === true,
      origin: typeof contextRecord["origin"] === "string" ? contextRecord["origin"] : "",
      name: typeof contextRecord["name"] === "string" ? contextRecord["name"] : "",
    });
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP target session is not open");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`CDP request ${method} aborted`), { code: "ABORT_ERR" }));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve(value) {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject(reason) {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async listExecutionContexts(options: { signal?: AbortSignal }): Promise<CdpExecutionContext[]> {
    this.contexts.clear();
    this.contextError = null;
    await this.request("Runtime.enable", {}, options.signal);
    await Promise.resolve();
    if (this.contextError !== null) throw this.contextError;
    return [...this.contexts.values()].map((context) => ({ ...context }));
  }

  async evaluate(input: {
    executionContextId: number;
    executionContextUniqueId: string;
    expression: string;
    signal?: AbortSignal;
  }): Promise<CdpEvaluationResult> {
    if (!Number.isInteger(input.executionContextId) || input.executionContextId <= 0) {
      throw new Error("CDP execution context id must be a positive integer");
    }
    if (input.executionContextUniqueId.length === 0) {
      throw new Error("CDP execution context uniqueId must be non-empty");
    }
    const result = await this.request("Runtime.evaluate", {
      expression: input.expression,
      uniqueContextId: input.executionContextUniqueId,
      returnByValue: true,
      awaitPromise: true,
    }, input.signal);
    if (!isRecord(result)) throw new Error("CDP Runtime.evaluate returned a malformed result");
    if ("exceptionDetails" in result) {
      throw new Error("CDP Runtime.evaluate returned exceptionDetails");
    }
    if (!isRecord(result["result"])) {
      throw new Error("CDP Runtime.evaluate returned a malformed remote result");
    }
    const remote = result["result"];
    const remoteType = remote["type"];
    if (typeof remoteType !== "string" || remoteType.length === 0) {
      throw new Error("CDP Runtime.evaluate remote result type is malformed");
    }
    if ("objectId" in remote || "unserializableValue" in remote) {
      throw new Error("CDP Runtime.evaluate returned an unsupported remote result representation");
    }
    if (remoteType === "undefined") {
      if ("value" in remote) {
        throw new Error("CDP Runtime.evaluate undefined result must not include value");
      }
      return { value: undefined };
    }
    if (!("value" in remote)) {
      throw new Error("CDP Runtime.evaluate remote result omitted value");
    }
    const value = remote["value"];
    if (remoteType === "string" && typeof value !== "string") {
      throw new Error("CDP Runtime.evaluate string result had a non-string value");
    }
    if (remoteType === "boolean" && typeof value !== "boolean") {
      throw new Error("CDP Runtime.evaluate boolean result had a non-boolean value");
    }
    if (remoteType === "number" && typeof value !== "number") {
      throw new Error("CDP Runtime.evaluate number result had a non-number value");
    }
    if (remoteType === "object" && value !== null && typeof value !== "object") {
      throw new Error("CDP Runtime.evaluate object result had a non-object value");
    }
    if (!["string", "boolean", "number", "object"].includes(remoteType)) {
      throw new Error(`CDP Runtime.evaluate returned unsupported remote type ${remoteType}`);
    }
    return { value };
  }

  async close(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.closed = true;
      return;
    }
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("CDP websocket close timeout must be a finite positive number");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.removeEventListener("close", onClose);
        this.socket.removeEventListener("error", onError);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onClose = (): void => {
        this.closed = true;
        finish();
      };
      const onError = (): void => {
        finish(new Error("CDP websocket failed while closing"));
      };
      const timer = setTimeout(() => {
        finish(Object.assign(new Error(`CDP websocket close timed out after ${timeoutMs}ms`), {
          code: "cdp_session_close_timeout" as const,
          boundMs: timeoutMs,
        }));
      }, timeoutMs);
      this.socket.addEventListener("close", onClose, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    });
  }
}

export function createNodeCdpAdapter(): CdpAdapter {
  return {
    async readEndpoint(input) {
      const value = await readJson({ ...input, path: "/json/version" });
      if (!isRecord(value)) throw new Error("CDP /json/version response must be an object");
      const webSocketDebuggerUrl = requiredString(value, "webSocketDebuggerUrl");
      validateWebSocketUrl(webSocketDebuggerUrl, input.host, input.port);
      return {
        browser: requiredString(value, "Browser"),
        protocolVersion: requiredString(value, "Protocol-Version"),
        webSocketDebuggerUrl,
        pid: optionalPid(value),
      };
    },
    async listTargets(input) {
      const value = await readJson({ ...input, path: "/json/list" });
      if (!Array.isArray(value)) throw new Error("CDP /json/list response must be an array");
      return value.map((candidate, index) => {
        if (!isRecord(candidate)) throw new Error(`CDP target ${index} must be an object`);
        const webSocketDebuggerUrl = optionalString(candidate, "webSocketDebuggerUrl");
        if (webSocketDebuggerUrl !== undefined) {
          validateWebSocketUrl(webSocketDebuggerUrl, input.host, input.port);
        }
        return {
          id: requiredString(candidate, "id"),
          type: requiredString(candidate, "type"),
          url: requiredString(candidate, "url"),
          title: typeof candidate["title"] === "string" ? candidate["title"] : "",
          webSocketDebuggerUrl,
        };
      });
    },
    async openTargetSession(input) {
      const url = input.target.webSocketDebuggerUrl;
      if (url === undefined) throw new Error(`Target ${input.target.id} has no websocket URL`);
      validateTargetWebSocketUrl(url, input.host, input.port, input.target.id);
      const session = await NodeCdpTargetSession.connect({
        targetId: input.target.id,
        webSocketDebuggerUrl: url,
        signal: input.signal,
      });
      input.onSessionOpened?.(session);
      return session;
    },
  };
}
