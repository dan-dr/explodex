/** Shared CDP helpers for isolated Explodex diagnostics. */

export const CDP_HOST = "127.0.0.1" as const;
export const CDP_PORT = 9444 as const;
export const EXACT_RENDERER_URL = "app://-/index.html" as const;

export type CdpTarget = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

type CdpResponse = {
  id?: number;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
};

export async function waitForDevelopmentPort(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The isolated instance may still be starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Isolated development CDP is not reachable at http://${CDP_HOST}:${CDP_PORT}. Run explodex dev ensure first.`,
  );
}

export async function getDevelopmentTargets(): Promise<CdpTarget[]> {
  const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`CDP target listing failed with HTTP ${response.status}.`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error("CDP target listing was not an array.");
  return value.filter((item): item is CdpTarget => item !== null && typeof item === "object");
}

export function exactRendererTarget(targets: readonly CdpTarget[]): CdpTarget {
  const matches = targets.filter(
    (target) =>
      target.type === "page" &&
      target.url === EXACT_RENDERER_URL &&
      typeof target.webSocketDebuggerUrl === "string" &&
      target.webSocketDebuggerUrl.length > 0,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${EXACT_RENDERER_URL} renderer on port ${CDP_PORT}; found ${matches.length}.`,
    );
  }
  return matches[0]!;
}

export class CdpSession {
  private nextId = 0;

  private constructor(private readonly socket: WebSocket) {}

  static async connect(target: CdpTarget): Promise<CdpSession> {
    const url = target.webSocketDebuggerUrl;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("Exact renderer target has no WebSocket debugger URL.");
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("CDP WebSocket connection failed."));
      };
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error("CDP WebSocket connection timed out after 5000ms."));
      }, 5_000);
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    return new CdpSession(socket);
  }

  close(): void {
    this.socket.close();
  }

  async evaluate(
    expression: string,
    options: { allowUnsafeEvalBlockedByCSP?: boolean; awaitPromise?: boolean } = {},
  ): Promise<unknown> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? false,
      allowUnsafeEvalBlockedByCSP: options.allowUnsafeEvalBlockedByCSP ?? false,
    });
    if (response.error?.message) throw new Error(response.error.message);
    const details = response.result?.exceptionDetails;
    if (details) {
      throw new Error(details.exception?.description ?? details.text ?? "CDP evaluation failed.");
    }
    return response.result?.result?.value ?? null;
  }

  async evaluateChunks(source: string, chunkKey: string, chunkSize = 48_000): Promise<void> {
    await this.evaluate(`window[${JSON.stringify(chunkKey)}] = []`);
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      const chunk = source.slice(offset, offset + chunkSize);
      await this.evaluate(
        `window[${JSON.stringify(chunkKey)}].push(${JSON.stringify(chunk)})`,
      );
    }
    await this.evaluate(
      `(() => {
        const key = ${JSON.stringify(chunkKey)};
        const source = window[key].join("");
        delete window[key];
        (0, eval)(source);
        return true;
      })()`,
      { allowUnsafeEvalBlockedByCSP: true },
    );
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<CdpResponse> {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise<CdpResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.socket.removeEventListener("message", onMessage);
      };
      const onMessage = (event: MessageEvent): void => {
        try {
          const response = JSON.parse(String(event.data)) as CdpResponse;
          if (response.id !== id) return;
          cleanup();
          resolve(response);
        } catch {
          // Ignore unrelated malformed notifications.
        }
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.socket.addEventListener("message", onMessage);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

export async function openExactRendererSession(): Promise<CdpSession> {
  await waitForDevelopmentPort();
  return CdpSession.connect(exactRendererTarget(await getDevelopmentTargets()));
}
