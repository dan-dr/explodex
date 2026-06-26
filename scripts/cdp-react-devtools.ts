#!/usr/bin/env bun
/**
 * Probe React component trees in the live Codex renderer via CDP.
 *
 * Codex is a production React build. Full React DevTools requires the global hook
 * before React boots (renderer reload). This script:
 *   1. Installs __REACT_DEVTOOLS_GLOBAL_HOOK__ when missing (takes effect after reload)
 *   2. Walks __reactFiber$* keys on sidebar DOM nodes (works immediately)
 *   3. Optionally eval-loads react-devtools-inline backend when EXPLODEX_REACT_DEVTOOLS_BACKEND=1
 *
 *   bun scripts/cdp-react-devtools.ts
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

const BACKEND_CDN =
  process.env.REACT_DEVTOOLS_BACKEND_CDN ??
  "https://unpkg.com/react-devtools-inline@4.4.0/dist/backend.js";
const CACHE_PATH = join(homedir(), ".explodex", "cache", "react-devtools-inline-backend.js");
const CHUNK_CHARS = Number(process.env.EXPLODEX_REACT_DEVTOOLS_CHUNK_CHARS ?? "48000");
const LOAD_BACKEND = (process.env.EXPLODEX_REACT_DEVTOOLS_BACKEND ?? "0") === "1";

const HOOK_EXPR = `(() => {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    return { ok: true, already: true, renderers: window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers?.size ?? 0 };
  }

  const renderers = new Map();
  const hook = {
    renderers,
    supportsFiber: true,
    inject: (renderer) => {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };

  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: hook,
  });

  return { ok: true, installed: true, renderers: 0 };
})()`;

const PROBE_EXPR = `(() => {
  function fiberName(fiber) {
    return (
      fiber?.type?.displayName ||
      fiber?.type?.name ||
      fiber?.elementType?.displayName ||
      fiber?.elementType?.name ||
      null
    );
  }

  function domFiberChain(el, limit = 24) {
    if (!el || typeof el !== "object") return [];
    const key = Object.keys(el).find((name) => name.startsWith("__reactFiber"));
    if (!key) return [];
    const names = [];
    let fiber = el[key];
    for (let i = 0; fiber && i < limit; i += 1) {
      const name = fiberName(fiber);
      if (name) names.push(name);
      fiber = fiber.return;
    }
    return names;
  }

  const sidebar =
    document.querySelector('aside[data-testid="app-shell-floating-left-panel"]') ||
    document.querySelector('aside.app-shell-left-panel') ||
    document.querySelector('[data-testid="app-shell-floating-left-panel"]');

  const nav = sidebar?.querySelector("nav");
  const profileFooter =
    sidebar?.querySelector('button[aria-label*="settings" i]') ??
    sidebar?.querySelector('button[aria-label*="Open settings" i]');

  const pluginsBtn = sidebar
    ? Array.from(sidebar.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").replace(/\\s+/g, " ").trim().toLowerCase().startsWith("plugins"),
      )
    : null;

  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const rendererIds = hook?.renderers ? [...hook.renderers.keys()] : [];

  return {
    ok: true,
    hookPresent: !!hook,
    hookRenderers: rendererIds.length,
    backendLoaded: !!window.__explodexReactDevtoolsBackendAttempted,
    domFiberChains: {
      sidebar: domFiberChain(sidebar),
      nav: domFiberChain(nav),
      profileFooter: domFiberChain(profileFooter),
      pluginsButton: domFiberChain(pluginsBtn),
    },
    hint:
      rendererIds.length > 0
        ? "DevTools hook has renderers — open React DevTools standalone to inspect."
        : "Hook installed but no renderers yet. Reload the Codex renderer (or restart app) after hook install for full DevTools UI. DOM fiber chains above work without reload.",
  };
})()`;

async function fetchBackendSource(): Promise<string> {
  if (process.env.EXPLODEX_REACT_DEVTOOLS_SKIP_CACHE !== "1") {
    try {
      const cached = readFileSync(CACHE_PATH, "utf8");
      if (cached.length > 100_000) return cached;
    } catch {
      /* cache miss */
    }
  }

  const res = await fetch(BACKEND_CDN, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Failed to fetch react-devtools backend: HTTP ${res.status}`);
  const source = await res.text();
  if (source.length < 100_000) throw new Error("react-devtools backend bundle looks truncated");

  try {
    mkdirSync(join(homedir(), ".explodex", "cache"), { recursive: true });
    writeFileSync(CACHE_PATH, source, "utf8");
  } catch {
    /* non-fatal */
  }

  return source;
}

async function tryLoadBackend(session: CdpSession, source: string): Promise<unknown> {
  await session.evaluate(`window.__explodexReactDevtoolsChunks = []`);
  for (let i = 0; i < source.length; i += CHUNK_CHARS) {
    await session.evaluate(
      `window.__explodexReactDevtoolsChunks.push(${JSON.stringify(source.slice(i, i + CHUNK_CHARS))})`,
    );
  }

  return session.evaluate(
    `(() => {
      window.__explodexReactDevtoolsBackendAttempted = true;
      try {
        const src = window.__explodexReactDevtoolsChunks.join("");
        delete window.__explodexReactDevtoolsChunks;
        const module = { exports: {} };
        const fn = new Function("module", src);
        fn(module);
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (typeof module.exports === "function") module.exports(hook);
        else if (typeof module.exports?.activate === "function") module.exports.activate(hook);
        return { ok: true, exportType: typeof module.exports, renderers: hook.renderers?.size ?? 0 };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    })()`,
    { allowUnsafeEvalBlockedByCSP: true },
  );
}

async function main(): Promise<void> {
  if (!(await waitForPort(CDP_HOST, CDP_PORT))) {
    console.error(`ERROR: CDP not reachable at http://${CDP_HOST}:${CDP_PORT}`);
    console.error("Start Explodex with remote debugging (bun run dev) first.");
    process.exit(1);
  }

  const pages = injectablePages(await getTargets());
  if (!pages.length) {
    console.error("ERROR: No injectable renderer page found.");
    process.exit(1);
  }

  let backendSource: string | null = null;
  if (LOAD_BACKEND) {
    console.error(`Fetching react-devtools backend from ${BACKEND_CDN}`);
    backendSource = await fetchBackendSource();
  }

  for (const page of pages) {
    const wsUrl = page.webSocketDebuggerUrl;
    if (!wsUrl) continue;
    console.error(`Probing React layout in ${targetLabel(page)}`);
    const session = await CdpSession.connect(wsUrl);
    try {
      const hook = await session.evaluate(HOOK_EXPR);
      let backend: unknown = { skipped: true };
      if (backendSource) {
        backend = await tryLoadBackend(session, backendSource);
      }
      const probe = await session.evaluate(PROBE_EXPR);
      console.log(JSON.stringify({ hook, backend, probe }, null, 2));
    } finally {
      session.close();
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}