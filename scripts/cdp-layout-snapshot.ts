#!/usr/bin/env bun
/**
 * Capture a structured layout snapshot from the live Codex renderer via CDP.
 *
 * Writes JSON to stdout and optionally to ~/.explodex/snapshots/layout-<timestamp>.json
 *
 * Usage:
 *   bun scripts/cdp-layout-snapshot.ts
 *   EXPLODEX_LAYOUT_SNAPSHOT_OUT=./layout.json bun scripts/cdp-layout-snapshot.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
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

const LAYOUT_SNAPSHOT_EXPR = `(() => {
  const trim = (s) => (s ?? "").replace(/\\s+/g, " ").trim();

  function rectSummary(el) {
    if (!el?.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  const sidebar =
    document.querySelector('aside[data-testid="app-shell-floating-left-panel"]') ||
    document.querySelector('aside.app-shell-left-panel') ||
    document.querySelector('[data-testid="app-shell-floating-left-panel"]');

  const shell = {
    mainContentLayout: document
      .querySelector("[data-app-shell-main-content-layout]")
      ?.getAttribute("data-app-shell-main-content-layout") ?? null,
    focusArea: document.querySelector("[data-app-shell-focus-area]")?.getAttribute("data-app-shell-focus-area") ?? null,
    tabId: document.querySelector("[data-tab-id]")?.getAttribute("data-tab-id") ?? null,
  };

  const navLandmarks = sidebar
    ? Array.from(sidebar.querySelectorAll("nav")).map((nav) => ({
        ariaLabel: nav.getAttribute("aria-label"),
        className: nav.className,
        buttonCount: nav.querySelectorAll("button").length,
        rect: rectSummary(nav),
      }))
    : [];

  const navButtons = sidebar
    ? Array.from(sidebar.querySelectorAll("button"))
        .slice(0, 60)
        .map((btn) => ({
          text: trim(btn.textContent).slice(0, 100),
          ariaLabel: btn.getAttribute("aria-label"),
          className: (btn.className || "").slice(0, 160),
          rect: rectSummary(btn),
        }))
    : [];

  const sidebarDataAttrs = {};
  if (sidebar) {
    for (const el of sidebar.querySelectorAll("[data-app-action-sidebar-thread-id], [data-app-action-sidebar-project-id], [data-app-action-sidebar-section], [data-app-action-sidebar-scroll]")) {
      for (const attr of el.attributes) {
        if (!attr.name.startsWith("data-app-action-sidebar")) continue;
        sidebarDataAttrs[attr.name] = (sidebarDataAttrs[attr.name] ?? 0) + 1;
      }
    }
  }

  const profileFooterBtn =
    sidebar?.querySelector('button[aria-label*="settings" i]') ??
    sidebar?.querySelector('button[aria-label*="Open settings" i]') ??
    null;

  const footerHost = profileFooterBtn?.closest('[class*="absolute"][class*="bottom-0"]') ?? null;

  const desktopRouteLabels = navButtons
    .map((b) => b.text)
    .filter((t) => /^(library|automations|plugins|skills|pull requests)$/i.test(t));

  function fiberName(fiber) {
    return (
      fiber?.type?.displayName ||
      fiber?.type?.name ||
      fiber?.elementType?.displayName ||
      fiber?.elementType?.name ||
      null
    );
  }

  function domFiberChain(el, limit = 16) {
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

  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;

  let react = {
    hookPresent: !!hook,
    rendererCount: hook?.renderers?.size ?? 0,
    domFiberChains: {
      sidebar: domFiberChain(sidebar),
      profileFooter: domFiberChain(profileFooterBtn),
      nav: domFiberChain(sidebar?.querySelector("nav")),
    },
    devtoolsFiberSample: [],
  };

  if (hook?.renderers?.size) {
    const renderer = hook.renderers.get([...hook.renderers.keys()][0]);
    const root = renderer?.findFiberByHostInstance?.(sidebar ?? document.documentElement);
    let fiber = root;
    const names = [];
    for (let i = 0; fiber && i < 12; i += 1) {
      const name = fiberName(fiber);
      if (name) names.push(name);
      fiber = fiber.return;
    }
    react.devtoolsFiberSample = names;
  }

  const zones = {
    aboveComposer: !!document.querySelector("[data-above-composer-portal]"),
    threadFooter: !!document.querySelector('[data-thread-scroll-footer="true"]'),
    browserSidebarBanner: !!document.querySelector('[data-testid="browser-sidebar-top-banner-portal"]'),
    homeAmbient: !!document.querySelector("[data-home-ambient-suggestions]"),
  };

  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    codexVersion: document.querySelector("meta[name='codex-version']")?.getAttribute("content") ?? null,
    shell,
    zones,
    sidebar: sidebar
      ? {
          tag: sidebar.tagName.toLowerCase(),
          testId: sidebar.getAttribute("data-testid"),
          className: sidebar.className,
          rect: rectSummary(sidebar),
          cssVars: {
            sidebarFooterHeight: getComputedStyle(sidebar).getPropertyValue("--sidebar-footer-height").trim() || null,
          },
        }
      : null,
    navLandmarks,
    navButtons,
    desktopRouteLabels,
    sidebarDataAttrs,
    profileFooter: profileFooterBtn
      ? {
          ariaLabel: profileFooterBtn.getAttribute("aria-label"),
          text: trim(profileFooterBtn.textContent).slice(0, 100),
          rect: rectSummary(profileFooterBtn),
          footerHostClass: footerHost?.className ?? null,
        }
      : null,
    explodexNavMounts: Array.from(document.querySelectorAll("[data-explodex-nav]")).map((n) =>
      n.getAttribute("data-explodex-nav"),
    ),
    react,
  };
})()`;

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

  const snapshots: Array<{ page: string; snapshot: unknown }> = [];

  for (const page of pages) {
    const wsUrl = page.webSocketDebuggerUrl;
    if (!wsUrl) continue;
    const session = await CdpSession.connect(wsUrl);
    try {
      const snapshot = await session.evaluate(LAYOUT_SNAPSHOT_EXPR);
      snapshots.push({ page: targetLabel(page), snapshot });
    } finally {
      session.close();
    }
  }

  const payload = {
    host: CDP_HOST,
    port: CDP_PORT,
    pages: snapshots,
  };

  const json = JSON.stringify(payload, null, 2);
  console.log(json);

  const out = process.env.EXPLODEX_LAYOUT_SNAPSHOT_OUT?.trim();
  if (out) {
    writeFileSync(out, json, "utf8");
    console.error(`Wrote ${out}`);
    return;
  }

  const dir = join(homedir(), ".explodex", "snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `layout-${stamp}.json`);
  writeFileSync(path, json, "utf8");
  console.error(`Wrote ${path}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}