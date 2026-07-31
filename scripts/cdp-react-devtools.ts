#!/usr/bin/env bun
/** Probe React fibers in the exact isolated renderer without reloading it. */

import { openExactRendererSession } from "./cdp-client.ts";

const PROBE_EXPRESSION = `(() => {
  const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!existing) {
    const renderers = new Map();
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        renderers,
        supportsFiber: true,
        inject(renderer) {
          const id = renderers.size + 1;
          renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot() {},
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {},
      },
    });
  }

  const fiberChain = (element, limit = 24) => {
    if (!element || typeof element !== "object") return [];
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber"));
    if (!key) return [];
    const names = [];
    let fiber = element[key];
    for (let index = 0; fiber && index < limit; index += 1) {
      const name = fiber?.type?.displayName || fiber?.type?.name || fiber?.elementType?.name;
      if (name) names.push(name);
      fiber = fiber.return;
    }
    return names;
  };

  const sidebar =
    document.querySelector('aside[data-testid="app-shell-floating-left-panel"]') ||
    document.querySelector('aside.app-shell-left-panel') ||
    document.querySelector('[data-testid="app-shell-floating-left-panel"]');
  const settings =
    sidebar?.querySelector('button[aria-label*="settings" i]') ||
    sidebar?.querySelector('button[aria-label*="Open settings" i]');
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  return {
    ok: true,
    url: location.href,
    hookPresent: !!hook,
    rendererCount: hook?.renderers?.size ?? 0,
    hookInstalledNow: !existing,
    domFiberChains: {
      sidebar: fiberChain(sidebar),
      nav: fiberChain(sidebar?.querySelector("nav")),
      profileFooter: fiberChain(settings),
    },
    note: existing
      ? "Existing React DevTools hook inspected without reload."
      : "Hook installed for future renderer initialization. Current DOM fiber chains are available without reload.",
  };
})()`;

async function main(): Promise<void> {
  const session = await openExactRendererSession();
  try {
    const result = await session.evaluate(PROBE_EXPRESSION);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
