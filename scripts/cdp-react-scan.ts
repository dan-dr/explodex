#!/usr/bin/env bun
/** Inject react-scan into the exact isolated renderer for render diagnostics. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openExactRendererSession } from "./cdp-client.ts";

const SOURCE_URL =
  process.env.EXPLODEX_REACT_SCAN_CDN ?? "https://unpkg.com/react-scan/dist/auto.global.js";
const CACHE_PATH = join(homedir(), ".explodex", "cache", "react-scan-auto.global.js");
const LOG_RENDERS = process.env.EXPLODEX_REACT_SCAN_LOG === "1";

async function loadSource(): Promise<string> {
  if (process.env.EXPLODEX_REACT_SCAN_SKIP_CACHE !== "1") {
    try {
      const cached = await readFile(CACHE_PATH, "utf8");
      if (cached.length > 10_000) return cached;
    } catch {
      // Cache miss.
    }
  }

  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`react-scan download failed with HTTP ${response.status}.`);
  const source = await response.text();
  if (source.length < 10_000) throw new Error("react-scan bundle appears truncated.");
  await mkdir(join(homedir(), ".explodex", "cache"), { recursive: true });
  await writeFile(CACHE_PATH, source, "utf8");
  return source;
}

async function main(): Promise<void> {
  const session = await openExactRendererSession();
  try {
    const source = await loadSource();
    const alreadyLoaded = await session.evaluate(
      "!!(window.__explodexReactScanLoaded && window.reactScan)",
    );
    if (alreadyLoaded !== true) {
      await session.evaluateChunks(source, "__explodexReactScanChunks");
    }
    const configured = await session.evaluate(
      `(() => {
        const api = window.reactScan;
        if (!api) return { ok: false, error: "reactScan global missing" };
        const options = {
          enabled: true,
          dangerouslyForceRunInProduction: true,
          showToolbar: true,
          animationSpeed: "fast",
          log: ${LOG_RENDERS ? "true" : "false"},
        };
        if (typeof api === "function") api(options);
        else if (typeof api.scan === "function") api.scan(options);
        else if (typeof api.setOptions === "function") api.setOptions(options);
        else return { ok: false, error: "reactScan API not recognized" };
        window.__explodexReactScanLoaded = true;
        return { ok: true, alreadyLoaded: ${alreadyLoaded === true ? "true" : "false"}, options };
      })()`,
      { allowUnsafeEvalBlockedByCSP: true },
    );
    process.stdout.write(`${JSON.stringify(configured, null, 2)}\n`);
  } finally {
    session.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
