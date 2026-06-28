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
import {
  CDP_HOST,
  CDP_PORT,
  CdpSession,
  getTargets,
  injectablePages,
  targetLabel,
  waitForPort,
} from "./cdp-client.ts";

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

async function injectReactScan(wsUrl: string, bundleSource: string): Promise<unknown> {
  const session = await CdpSession.connect(wsUrl);
  try {
    const already = await session.evaluate(`!!(window.__explodexReactScanLoaded && window.reactScan)`);
    if (already === true) {
      const configured = await session.evaluate(CONFIGURE_EXPR);
      return configured ?? { ok: true, already: true };
    }

    await session.evaluateChunks(bundleSource, {
      chunkKey: "__explodexReactScanChunks",
      chunkChars: CHUNK_CHARS,
    });

    const configured = await session.evaluate(CONFIGURE_EXPR);
    return configured ?? null;
  } finally {
    session.close();
  }
}

async function main(): Promise<void> {
  if (!(await waitForPort(CDP_HOST, CDP_PORT))) {
    console.error(`ERROR: CDP not reachable at http://${CDP_HOST}:${CDP_PORT}`);
    console.error("Start Explodex with remote debugging (bun run dev) first.");
    process.exit(1);
  }

  console.log(`Fetching react-scan from ${REACT_SCAN_CDN}`);
  const bundleSource = await fetchReactScanSource();

  const pages = injectablePages(await getTargets(CDP_HOST, CDP_PORT));
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