/**
 * Shared Chrome DevTools Protocol helpers for Explodex scripts.
 */

export const CDP_HOST = "127.0.0.1";
export const CDP_PORT = Number(process.env.EXPLODEX_DEBUG_PORT ?? "9333");

export type Target = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

export type CdpResponse = {
  id?: number;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
};

export function cdpException(resp: CdpResponse): string | null {
  const details = resp.result?.exceptionDetails;
  if (!details) return null;
  return details.exception?.description ?? details.text ?? "CDP evaluate exception";
}

export async function waitForPort(
  host = CDP_HOST,
  port = CDP_PORT,
  timeout = 30_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      await Bun.sleep(500);
    }
  }
  return false;
}

export async function getTargets(host = CDP_HOST, port = CDP_PORT): Promise<Target[]> {
  try {
    const res = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    return (await res.json()) as Target[];
  } catch {
    return [];
  }
}

export function isInjectablePage(target: Target): boolean {
  if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = (target.url ?? "").toLowerCase();
  const title = (target.title ?? "").toLowerCase();
  if (url.includes("devtools") || title.includes("devtools")) return false;
  return url.includes("codex") || title.includes("codex") || !url.includes("localhost");
}

export function injectablePages(targets: Target[]): Target[] {
  const matching = targets.filter(isInjectablePage);
  if (matching.length) return matching;
  return targets.filter(
    (t) => t.type === "page" && t.webSocketDebuggerUrl && !(t.url ?? "").toLowerCase().includes("devtools"),
  );
}

export function targetLabel(target: Target): string {
  return target.url || target.title || target.id || "untitled page";
}

export class CdpSession {
  private ws: WebSocket;
  private msgId = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket connect failed"));
    });
    return new CdpSession(ws);
  }

  close(): void {
    this.ws.close();
  }

  private send(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<CdpResponse> {
    return new Promise((resolve) => {
      this.msgId += 1;
      const id = this.msgId;
      const timer = setTimeout(() => resolve({ id }), timeoutMs);
      const handler = (ev: MessageEvent) => {
        try {
          const data = JSON.parse(String(ev.data)) as CdpResponse;
          if (data.id === id) {
            clearTimeout(timer);
            this.ws.removeEventListener("message", handler);
            resolve(data);
          }
        } catch {
          /* ignore */
        }
      };
      this.ws.addEventListener("message", handler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(
    expression: string,
    opts: { allowUnsafeEvalBlockedByCSP?: boolean; awaitPromise?: boolean } = {},
  ): Promise<unknown> {
    const resp = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? false,
      allowUnsafeEvalBlockedByCSP: opts.allowUnsafeEvalBlockedByCSP ?? false,
    });
    if (resp.error?.message) throw new Error(resp.error.message);
    const err = cdpException(resp);
    if (err) throw new Error(err);
    return resp.result?.result?.value ?? null;
  }

  async evaluateChunks(
    source: string,
    opts: { chunkKey: string; chunkChars?: number } ,
  ): Promise<void> {
    const chunkChars = opts.chunkChars ?? 48_000;
    const chunks: string[] = [];
    for (let i = 0; i < source.length; i += chunkChars) {
      chunks.push(source.slice(i, i + chunkChars));
    }

    await this.evaluate(`window.${opts.chunkKey} = []`);
    for (const chunk of chunks) {
      await this.evaluate(`window.${opts.chunkKey}.push(${JSON.stringify(chunk)})`);
    }
    await this.evaluate(
      `(() => {
        const src = window.${opts.chunkKey}.join("");
        delete window.${opts.chunkKey};
        (0, eval)(src);
        return { loaded: true };
      })()`,
      { allowUnsafeEvalBlockedByCSP: true },
    );
  }
}