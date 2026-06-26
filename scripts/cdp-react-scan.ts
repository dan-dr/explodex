#!/usr/bin/env bun
/**
 * Inject react-scan into the live Codex renderer via CDP.
 * https://github.com/aidenybai/react-scan
 *
 * Codex CSP blocks external <script src>. The bundle is fetched on the host,
 * shipped in CDP chunks, and eval'd with allowUnsafeEvalBlockedByCSP.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.EXPLODEX_DEBUG_PORT ?? "9333");
const HOST = "127.0.0.1";
const REACT_SCAN_CDN =
  process.env.EXPLODEX_REACT_SCAN_CDN ??
  "https://unpkg.com/react-scan/dist/auto.global.js";
const LOG_RENDERS = (process.env.EXPLODEX_REACT_SCAN_LOG ?? "0") === "1";
const CHUNK_CHARS = Number(process.env.EXPLODEX_REACT_SCAN_CHUNK_CHARS ?? "48000");
const CACHE_PATH = join(homedir(), ".explodex", "cache", "react-scan-auto.global.js");

const CONFIGURE_EXPR = `(() => {
  const finish = (result) => {
    if (result?.ok) window.__explodexReactScanLoaded = true;
    return result;
  };

  if (window.__explodexReactScanLoaded && window.reactScan) {
    return { ok: true, already: true, api: typeof window.reactScan };
  }

  const api = window.reactScan;
  if (!api) return { ok: false, error: "reactScan global missing after script load" };

  const options = {
    enabled: true,
    dangerouslyForceRunInProduction: true,
    showToolbar: true,
    animationSpeed: "fast",
    log: ${LOG_RENDERS ? "true" : "false"},
  };

  // auto.global.js sets window.reactScan to the scan function itself (not { scan }).
  if (typeof api === "function") api(options);
  else if (typeof api.scan === "function") api.scan(options);
  else if (typeof api.setOptions === "function") api.setOptions(options);
  else return { ok: false, error: "reactScan API not recognized", api: typeof api };

  return finish({ ok: true, api: typeof api, options });
})()`;

type Target = {
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

function chunkSource(source: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < source.length; i += size) {
    chunks.push(source.slice(i, i + size));
  }
  return chunks;
}

async function fetchReactScanSource(): Promise<string> {
  if (process.env.EXPLODEX_REACT_SCAN_SKIP_CACHE !== "1") {
    try {
      const cached = readFileSync(CACHE_PATH, "utf8");
      if (cached.length > 10_000) return cached;
    } catch {
      /* cache miss */
    }
  }

  const res = await fetch(REACT_SCAN_CDN, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Failed to fetch react-scan: HTTP ${res.status}`);
  const source = await res.text();
  if (source.length < 10_000) throw new Error("react-scan bundle looks truncated");

  try {
    mkdirSync(join(homedir(), ".explodex", "cache"), { recursive: true });
    writeFileSync(CACHE_PATH, source, "utf8");
  } catch {
    /* non-fatal */
  }

  return source;
}

async function waitForPort(host: string, port: number, timeout = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      await Bun.sleep(500);
    }
  }
  return false;
}

async function getTargets(): Promise<Target[]> {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    return (await res.json()) as Target[];
  } catch {
    return [];
  }
}

function isInjectablePage(target: Target): boolean {
  if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = (target.url ?? "").toLowerCase();
  const title = (target.title ?? "").toLowerCase();
  if (url.includes("devtools") || title.includes("devtools")) return false;
  return url.includes("codex") || title.includes("codex") || !url.includes("localhost");
}

function injectablePages(targets: Target[]): Target[] {
  const matching = targets.filter(isInjectablePage);
  if (matching.length) return matching;
  return targets.filter(
    (t) => t.type === "page" && t.webSocketDebuggerUrl && !(t.url ?? "").toLowerCase().includes("devtools"),
  );
}

function targetLabel(target: Target): string {
  return target.url || target.title || target.id || "untitled page";
}

function cdpException(resp: CdpResponse): string | null {
  const details = resp.result?.exceptionDetails;
  if (!details) return null;
  return details.exception?.description ?? details.text ?? "CDP evaluate exception";
}

async function injectReactScan(wsUrl: string, bundleSource: string): Promise<unknown> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket connect failed"));
  });

  try {
    let msgId = 0;
    const send = (method: string, params: Record<string, unknown>, timeoutMs = 60_000) =>
      new Promise<CdpResponse>((resolve) => {
        msgId += 1;
        const id = msgId;
        const timer = setTimeout(() => resolve({ id }), timeoutMs);
        const handler = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(String(ev.data)) as CdpResponse;
            if (data.id === id) {
              clearTimeout(timer);
              ws.removeEventListener("message", handler);
              resolve(data);
            }
          } catch {
            /* ignore */
          }
        };
        ws.addEventListener("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const evaluate = async (
      expression: string,
      opts: { allowUnsafeEvalBlockedByCSP?: boolean; awaitPromise?: boolean } = {},
    ) => {
      const resp = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? false,
        allowUnsafeEvalBlockedByCSP: opts.allowUnsafeEvalBlockedByCSP ?? false,
      });
      if (resp.error?.message) throw new Error(resp.error.message);
      const err = cdpException(resp);
      if (err) throw new Error(err);
      return resp;
    };

    const already = await evaluate(
      `!!(window.__explodexReactScanLoaded && window.reactScan)`,
    );
    if (already.result?.result?.value === true) {
      const configured = await evaluate(CONFIGURE_EXPR);
      return configured.result?.result?.value ?? { ok: true, already: true };
    }

    await evaluate(`window.__explodexReactScanChunks = []`);

    const chunks = chunkSource(bundleSource, CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunkJson = JSON.stringify(chunks[i]);
      await evaluate(`window.__explodexReactScanChunks.push(${chunkJson})`);
    }

    await evaluate(
      `(() => {
        const src = window.__explodexReactScanChunks.join("");
        delete window.__explodexReactScanChunks;
        (0, eval)(src);
        return { loaded: typeof window.reactScan };
      })()`,
      { allowUnsafeEvalBlockedByCSP: true },
    );

    const configured = await evaluate(CONFIGURE_EXPR);
    return configured.result?.result?.value ?? null;
  } finally {
    ws.close();
  }
}

async function main(): Promise<void> {
  if (!(await waitForPort(HOST, PORT))) {
    console.error(`ERROR: CDP not reachable at http://${HOST}:${PORT}`);
    console.error("Start Explodex with remote debugging (bun run dev) first.");
    process.exit(1);
  }

  console.log(`Fetching react-scan from ${REACT_SCAN_CDN}`);
  const bundleSource = await fetchReactScanSource();

  const pages = injectablePages(await getTargets());
  if (!pages.length) {
    console.error("ERROR: No injectable renderer page found.");
    process.exit(1);
  }

  for (const page of pages) {
    const wsUrl = page.webSocketDebuggerUrl;
    if (!wsUrl) continue;
    console.log(`Injecting react-scan into ${targetLabel(page)}`);
    const result = await injectReactScan(wsUrl, bundleSource);
    console.log(JSON.stringify(result, null, 2));
  }

  console.log("react-scan toolbar should appear in the Codex window.");
  console.log("Re-run with EXPLODEX_REACT_SCAN_LOG=1 to mirror hot renders to the console.");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}