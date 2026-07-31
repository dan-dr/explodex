#!/usr/bin/env bun
/** Capture current layout landmarks from the exact isolated renderer. */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CDP_HOST, CDP_PORT, openExactRendererSession } from "./cdp-client.ts";

const SNAPSHOT_EXPRESSION = `(() => {
  const trim = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
  const rect = (element) => {
    if (!element?.getBoundingClientRect) return null;
    const value = element.getBoundingClientRect();
    return {
      x: Math.round(value.x),
      y: Math.round(value.y),
      width: Math.round(value.width),
      height: Math.round(value.height),
    };
  };
  const sidebar =
    document.querySelector('aside[data-testid="app-shell-floating-left-panel"]') ||
    document.querySelector('aside.app-shell-left-panel') ||
    document.querySelector('[data-testid="app-shell-floating-left-panel"]');
  const navLandmarks = sidebar
    ? Array.from(sidebar.querySelectorAll("nav")).map((nav) => ({
        ariaLabel: nav.getAttribute("aria-label"),
        className: nav.className,
        buttonCount: nav.querySelectorAll("button").length,
        rect: rect(nav),
      }))
    : [];
  const settings =
    sidebar?.querySelector('button[aria-label*="settings" i]') ||
    sidebar?.querySelector('button[aria-label*="Open settings" i]') ||
    null;
  const sidebarDataAttrs = {};
  if (sidebar) {
    for (const element of sidebar.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (!attribute.name.startsWith("data-app-action-sidebar")) continue;
        sidebarDataAttrs[attribute.name] = (sidebarDataAttrs[attribute.name] ?? 0) + 1;
      }
    }
  }
  const fiberChain = (element, limit = 16) => {
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
  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    shell: {
      mainContentLayout: document.querySelector("[data-app-shell-main-content-layout]")?.getAttribute("data-app-shell-main-content-layout") ?? null,
      focusArea: document.querySelector("[data-app-shell-focus-area]")?.getAttribute("data-app-shell-focus-area") ?? null,
      tabId: document.querySelector("[data-tab-id]")?.getAttribute("data-tab-id") ?? null,
    },
    sidebar: sidebar ? {
      tag: sidebar.tagName.toLowerCase(),
      testId: sidebar.getAttribute("data-testid"),
      className: sidebar.className,
      rect: rect(sidebar),
    } : null,
    navLandmarks,
    profileFooter: settings ? {
      ariaLabel: settings.getAttribute("aria-label"),
      text: trim(settings.textContent).slice(0, 100),
      rect: rect(settings),
    } : null,
    sidebarDataAttrs,
    zones: {
      aboveComposer: !!document.querySelector("[data-above-composer-portal]"),
      threadFooter: !!document.querySelector('[data-thread-scroll-footer="true"]'),
      browserSidebarBanner: !!document.querySelector('[data-testid="browser-sidebar-top-banner-portal"]'),
      homeAmbient: !!document.querySelector("[data-home-ambient-suggestions]"),
    },
    explodexNavMounts: Array.from(document.querySelectorAll("[data-explodex-nav]")).map((element) => element.getAttribute("data-explodex-nav")),
    react: {
      hookPresent: !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
      rendererCount: window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size ?? 0,
      domFiberChains: {
        sidebar: fiberChain(sidebar),
        profileFooter: fiberChain(settings),
        nav: fiberChain(sidebar?.querySelector("nav")),
      },
    },
  };
})()`;

async function main(): Promise<void> {
  const session = await openExactRendererSession();
  let snapshot: unknown;
  try {
    snapshot = await session.evaluate(SNAPSHOT_EXPRESSION);
  } finally {
    session.close();
  }

  const payload = { host: CDP_HOST, port: CDP_PORT, pages: [{ page: "app://-/index.html", snapshot }] };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  process.stdout.write(json);

  const configured = process.env.EXPLODEX_LAYOUT_SNAPSHOT_OUT?.trim();
  const path = configured
    ? resolve(configured)
    : join(
        homedir(),
        ".explodex",
        "snapshots",
        `layout-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, "utf8");
  process.stderr.write(`Wrote ${path}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
