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
  /** True while the underlying websocket is not fully CLOSED. */
  isOpen(): boolean;
  listExecutionContexts(options: { signal?: AbortSignal }): Promise<CdpExecutionContext[]>;
  evaluate(input: {
    executionContextId: number;
    executionContextUniqueId: string;
    expression: string;
    signal?: AbortSignal;
  }): Promise<CdpEvaluationResult>;
  reloadRenderer?(input: {
    previousExecutionContextUniqueId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CdpExecutionContext>;
  bringToFront?(input: { signal?: AbortSignal }): Promise<void>;
  close(options?: { timeoutMs?: number }): Promise<void>;
};

/**
 * Reachable residual CDP session authority after registration fails and the
 * bounded close times out or rejects while the socket remains non-closed.
 */
export type ResidualSessionAuthority = {
  targetId: string;
  session: CdpTargetSession;
  isOpen(): boolean;
  dispose(options?: { timeoutMs?: number }): Promise<void>;
};

export type SessionRegistrationCleanupError = Error & {
  code: "cdp_session_registration_cleanup_failed";
  registrationError: unknown;
  cleanupError: unknown;
  residual: ResidualSessionAuthority;
  boundMs: number;
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
  /** Runtime domain stays enabled for the session lifetime after first enable. */
  private runtimeEnabled = false;

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
    // Node/Bun websocket runtimes may deliver text frames as string or Buffer/Uint8Array.
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw);
    } else if (ArrayBuffer.isView(raw)) {
      const view = raw as ArrayBufferView;
      text = new TextDecoder().decode(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      );
    } else if (
      typeof raw === "object" &&
      raw !== null &&
      "toString" in raw &&
      typeof (raw as { toString: () => string }).toString === "function"
    ) {
      text = (raw as { toString: () => string }).toString();
    } else {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
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
    if (method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
      return;
    }
    if (method === "Runtime.executionContextDestroyed") {
      const params = parsed["params"];
      if (isRecord(params) && Number.isInteger(params["executionContextId"])) {
        this.contexts.delete(Number(params["executionContextId"]));
      }
      return;
    }
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
    // Runtime.enable is sticky: a second enable does not re-emit existing context
    // events. Keep the session inventory across rechecks and only enable once.
    if (!this.runtimeEnabled) {
      this.contexts.clear();
      this.contextError = null;
      await this.request("Runtime.enable", {}, options.signal);
      this.runtimeEnabled = true;
      // Runtime.enable emits executionContextCreated for existing contexts
      // asynchronously. Poll briefly for at least one default context.
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        if (this.contextError !== null) throw this.contextError;
        const snapshot = [...this.contexts.values()];
        if (snapshot.some((context) => context.isDefault)) {
          return snapshot.map((context) => ({ ...context }));
        }
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 25);
        });
        if (options.signal?.aborted) {
          throw Object.assign(new Error("CDP listExecutionContexts aborted"), {
            code: "ABORT_ERR",
          });
        }
      }
    }
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

  async reloadRenderer(input: {
    previousExecutionContextUniqueId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CdpExecutionContext> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("Renderer reload timeout must be a finite positive number");
    }
    if (!this.runtimeEnabled) {
      await this.listExecutionContexts({ signal: input.signal });
    }
    await this.request("Page.enable", {}, input.signal);
    await this.request("Page.reload", { ignoreCache: false }, input.signal);
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) {
        throw Object.assign(new Error("Renderer reload was interrupted"), {
          code: "ABORT_ERR",
        });
      }
      if (this.contextError !== null) throw this.contextError;
      const defaults = [...this.contexts.values()].filter(
        (context) =>
          context.isDefault &&
          context.uniqueId !== input.previousExecutionContextUniqueId,
      );
      if (defaults.length === 1) return { ...defaults[0]! };
      if (defaults.length > 1) {
        throw new Error("Renderer reload produced multiple default contexts");
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 25);
      });
    }
    throw Object.assign(
      new Error(`Renderer reload timed out after ${input.timeoutMs}ms`),
      { code: "operation_timeout" as const, boundMs: input.timeoutMs },
    );
  }

  async bringToFront(input: { signal?: AbortSignal }): Promise<void> {
    await this.request("Page.bringToFront", {}, input.signal);
  }

  isOpen(): boolean {
    return !this.closed && this.socket.readyState !== WebSocket.CLOSED;
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

/** Declared bound for emergency close when session registration fails. */
export const REGISTRATION_SESSION_CLOSE_BOUND_MS = 250;

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
      try {
        input.onSessionOpened?.(session);
      } catch (registrationError: unknown) {
        // Registration failure must not leave an unreachable open session.
        // Close within the declared bound; close timeout/rejection must surface
        // residual session authority rather than discarding it.
        const closeBoundMs = REGISTRATION_SESSION_CLOSE_BOUND_MS;
        try {
          await session.close({ timeoutMs: closeBoundMs });
        } catch (cleanupError: unknown) {
          const residual: ResidualSessionAuthority = {
            targetId: session.targetId,
            session,
            isOpen: () => session.isOpen(),
            dispose: (options) => session.close(options),
          };
          const registrationMessage = registrationError instanceof Error
            ? registrationError.message
            : String(registrationError);
          const cleanupMessage = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
          const combined: SessionRegistrationCleanupError = Object.assign(
            new Error(
              `${registrationMessage}; residual CDP session cleanup failed: ${cleanupMessage}`,
            ),
            {
              code: "cdp_session_registration_cleanup_failed" as const,
              registrationError,
              cleanupError,
              residual,
              boundMs: closeBoundMs,
            },
          );
          throw combined;
        }
        throw registrationError;
      }
      return session;
    },
  };
}
