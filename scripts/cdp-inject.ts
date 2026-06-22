#!/usr/bin/env bun
/**
 * Runtime CDP injector for Explodex.
 * Injects SDK + plugin catalog into a running Codex instance via Chrome DevTools Protocol.
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.EXPLODEX_DEBUG_PORT ?? "9333");
const HOST = "127.0.0.1";
const TARGET_WATCH_MS = Number(process.env.EXPLODEX_TARGET_WATCH_MS ?? "8000");

type PluginEntry = {
  id: string;
  name: string;
  version: string;
  dynamicLoadable: boolean;
  dynamicUnloadable: boolean;
  source: string;
  path: string;
  [key: string]: unknown;
};

/** Directory for Resources next to a compiled cdp-inject-bin (Bun embeds code in /$bunfs). */
function injectorResourceDir(): string {
  const here = resolve(__dirname);
  if (!here.startsWith("/$bunfs")) return here;
  const exe = process.argv[0];
  return exe ? resolve(dirname(exe)) : here;
}

function findSdkPath(): string | null {
  const env = process.env.EXPLODEX_SDK_PATH ?? "";
  const resourceDir = injectorResourceDir();
  const candidates = [
    join(__dirname, "..", "sdk", "explodex-sdk.js"),
    join(resourceDir, "explodex-sdk.js"),
    join(__dirname, "explodex-sdk.js"),
    join(process.cwd(), "sdk", "explodex-sdk.js"),
    env,
  ];
  for (const cand of candidates) {
    if (cand && existsSync(cand) && statSync(cand).isFile()) return resolve(cand);
  }
  return null;
}

function findBundledPluginsDir(): string | null {
  const env = (process.env.EXPLODEX_BUNDLED_PLUGINS_DIR ?? "").trim();
  if (env) {
    const resolved = resolve(env);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) return resolved;
  }

  const sdkPath = (process.env.EXPLODEX_SDK_PATH ?? "").trim();
  if (sdkPath) {
    const sibling = join(dirname(resolve(sdkPath)), "plugins");
    if (existsSync(sibling) && statSync(sibling).isDirectory()) return sibling;
  }

  const here = injectorResourceDir();
  const candidates = [
    join(here, "plugins"),
    join(here, "..", "plugins"),
    join(here, "..", "..", "..", "plugins"),
  ];
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isDirectory()) return resolve(cand);
  }
  return null;
}

function userPluginsDir(): string {
  const env = (process.env.EXPLODEX_USER_PLUGINS_DIR ?? "").trim();
  if (env) return resolve(env);
  return join(homedir(), ".explodex", "plugins");
}

function ensureUserPluginsDir(): string {
  const dir = userPluginsDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return dir;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    console.warn(`WARN: could not read ${path}: ${err}`);
    return {};
  }
}

function parsePluginManifest(source: string, filename: string): Omit<PluginEntry, "source" | "path"> {
  const manifest = {
    id: basename(filename, extname(filename)),
    name: basename(filename, extname(filename)),
    version: "0.0.0",
    dynamicLoadable: true,
    dynamicUnloadable: true,
  };
  const block = source.match(/BC\.plugins\.register\s*\(\s*\{([\s\S]*?)\}\s*,/);
  if (!block) return manifest;

  const body = block[1];
  const pick = (key: string, fallback: string) => {
    const m = body.match(new RegExp(`${key}\\s*:\\s*['"]([^'"]+)['"]`));
    return m?.[1] ?? fallback;
  };
  const pickBool = (key: string, fallback: boolean) => {
    const m = body.match(new RegExp(`${key}\\s*:\\s*(true|false)`));
    return m ? m[1] === "true" : fallback;
  };

  return {
    id: pick("id", manifest.id),
    name: pick("name", manifest.name),
    version: pick("version", manifest.version),
    dynamicLoadable: pickBool("dynamicLoadable", true),
    dynamicUnloadable: pickBool("dynamicUnloadable", true),
  };
}

function pluginEntryFromFile(path: string): PluginEntry | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const source = readFileSync(path, "utf-8");
  const parsed = parsePluginManifest(source, basename(path));
  return { ...parsed, source, path };
}

function pluginEntryFromDir(path: string): PluginEntry | null {
  const manifestPath = join(path, "plugin.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {};
  const entryName = (manifest.entry as string) ?? "index.js";
  const entryPath = join(path, entryName);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    console.warn(`WARN: plugin ${basename(path)} has no entry file at ${entryPath}`);
    return null;
  }
  const source = readFileSync(entryPath, "utf-8");
  const parsed = parsePluginManifest(source, basename(entryPath));
  const id = (manifest.id as string) ?? basename(path);
  return {
    ...parsed,
    ...manifest,
    id,
    name: (manifest.name as string) ?? id,
    version: (manifest.version as string) ?? "0.0.0",
    source,
    path: entryPath,
  };
}

function discoverPluginsInDir(pluginsDir: string): PluginEntry[] {
  if (!existsSync(pluginsDir) || !statSync(pluginsDir).isDirectory()) return [];

  const entries: PluginEntry[] = [];
  for (const child of readdirSync(pluginsDir).sort()) {
    const full = join(pluginsDir, child);
    let entry: PluginEntry | null = null;
    if (statSync(full).isDirectory()) entry = pluginEntryFromDir(full);
    else if (extname(child) === ".js") entry = pluginEntryFromFile(full);
    if (entry) entries.push(entry);
  }
  return entries;
}

function mergePluginEntries(layers: Array<{ label: string; dir: string }>): PluginEntry[] {
  const byId = new Map<string, PluginEntry>();
  const sourceById = new Map<string, string>();

  for (const { label, dir } of layers) {
    for (const entry of discoverPluginsInDir(dir)) {
      const prev = byId.get(entry.id);
      if (prev) {
        console.warn(
          `WARN: plugin ${entry.id} from ${label} (${entry.path}) overrides ${sourceById.get(entry.id)}`,
        );
      }
      byId.set(entry.id, entry);
      sourceById.set(entry.id, `${label}:${entry.path}`);
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function discoverPlugins(): PluginEntry[] {
  const env = (process.env.EXPLODEX_PLUGINS ?? "").trim();
  if (env) {
    const entries: PluginEntry[] = [];
    for (const raw of env.split(":")) {
      const p = raw.trim();
      if (!p) continue;
      const resolved = resolve(p);
      const entry = statSync(resolved).isDirectory()
        ? pluginEntryFromDir(resolved)
        : pluginEntryFromFile(resolved);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  const layers: Array<{ label: string; dir: string }> = [];
  const bundled = findBundledPluginsDir();
  if (bundled) layers.push({ label: "bundled", dir: bundled });

  const userDir = ensureUserPluginsDir();
  layers.push({ label: "user", dir: userDir });

  const devDir = (process.env.EXPLODEX_PLUGINS_DIR ?? "").trim();
  if (devDir) layers.push({ label: "dev", dir: resolve(devDir) });

  return mergePluginEntries(layers);
}

function findRelaunchScript(): string | null {
  const resourceDir = injectorResourceDir();
  const candidates = [
    join(resourceDir, "relaunch.sh"),
    join(__dirname, "relaunch.sh"),
    join(__dirname, "..", "templates", "explodex-app", "Contents", "Resources", "relaunch.sh"),
  ];
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isFile()) return resolve(cand);
  }
  return null;
}

function buildCatalogBootstrap(pluginEntries: PluginEntry[]): string {
  const catalog = pluginEntries.map(({ path: _path, ...rest }) => rest);
  const relaunch = findRelaunchScript();
  const pathsMeta: Record<string, string> = {
    userPluginsDir: ensureUserPluginsDir(),
  };
  if (relaunch) pathsMeta.relaunchScript = `file://${relaunch}`;

  return [
    `window.__EXPLODEX_PLUGIN_CATALOG__ = ${JSON.stringify(catalog)};`,
    `window.__EXPLODEX_PATHS__ = ${JSON.stringify(pathsMeta)};`,
    "if (window.Explodex?.plugins?.initFromCatalog) {",
    "  window.Explodex.plugins.initFromCatalog();",
    "}",
  ].join("\n");
}

async function waitForPort(host: string, port: number, timeout = 30_000): Promise<boolean> {
  console.log(`Waiting for debugger on ${host}:${port}...`);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log("Debugger port is up.");
        return true;
      }
    } catch {
      await Bun.sleep(500);
    }
  }
  console.log("Timed out waiting for debugger port.");
  return false;
}

type Target = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

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
  const matchingPages = targets.filter(isInjectablePage);
  if (matchingPages.length) return matchingPages;
  const pageTargets = targets.filter((t) => t.type === "page");
  return pageTargets.filter((p) => p.webSocketDebuggerUrl && !(p.url ?? "").toLowerCase().includes("devtools"));
}

function targetLabel(target: Target): string {
  return target.url || target.title || target.id || "untitled page";
}

const RENDERER_READY_EXPR = `(() => {
  const root = document.getElementById("root");
  const rootChildren = root?.childElementCount ?? 0;
  const textLen = document.body?.innerText?.length ?? 0;
  return {
    readyState: document.readyState,
    rootChildren,
    textLen,
    ok: rootChildren > 0 && textLen > 50
  };
})()`;

async function waitForRendererReady(wsUrl: string, timeout = 45_000): Promise<boolean> {
  console.log("Waiting for renderer UI to mount...");
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeout) {
    try {
      const resp = await cdpRequest(wsUrl, "Runtime.evaluate", {
        expression: RENDERER_READY_EXPR,
        returnByValue: true,
      }, 9000 + attempt, 4000);
      const value = resp?.result?.result?.value as { ok?: boolean; readyState?: string; rootChildren?: number; textLen?: number } | undefined;
      if (value?.ok) {
        console.log(`Renderer ready (rootChildren=${value.rootChildren}, textLen=${value.textLen}).`);
        return true;
      }
      if (attempt % 5 === 0 && value) {
        console.log(
          `Renderer not ready yet (state=${value.readyState}, root=${value.rootChildren}, text=${value.textLen})...`,
        );
      }
    } catch (err) {
      if (attempt % 5 === 0) console.log(`Renderer readiness check failed: ${err}`);
    }
    attempt++;
    await Bun.sleep(500);
  }
  console.log("Timed out waiting for renderer UI to mount.");
  return false;
}

type CdpResponse = {
  result?: { result?: { value?: unknown; subtype?: string; description?: string; className?: string } };
  error?: { message?: string };
};

async function cdpRequest(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
  reqId = 1,
  timeoutMs = 5000,
): Promise<CdpResponse | null> {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket error")); };
    });

    const payload = JSON.stringify({ id: reqId, method, params });
    const response = await new Promise<CdpResponse | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(ev.data)) as CdpResponse);
        } catch {
          resolve(null);
        }
      };
      ws.send(payload);
    });
    return response;
  } finally {
    ws.close();
  }
}

function runtimeEvalError(resp: CdpResponse | null): string | null {
  if (!resp) return "no CDP response";
  const result = resp.result?.result;
  if (result?.subtype === "error") return result.description ?? result.className ?? "runtime error";
  if (resp.error) return resp.error.message ?? "CDP error";
  return null;
}

async function injectSourcesViaCdp(wsUrl: string, sources: Array<[string, string]>): Promise<void> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket connect failed"));
  });

  try {
    console.log("WebSocket connected.");
    let msgId = 0;
    const nextResponse = (id: number, timeoutMs: number) =>
      new Promise<CdpResponse | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        const handler = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(String(ev.data)) as { id?: number };
            if (data.id === id) {
              clearTimeout(timer);
              ws.removeEventListener("message", handler);
              resolve(data as CdpResponse);
            }
          } catch {
            /* ignore */
          }
        };
        ws.addEventListener("message", handler);
      });

    for (const [label, source] of sources) {
      msgId++;
      ws.send(JSON.stringify({
        id: msgId,
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source, world: "MAIN" },
      }));
      console.log(`Sent addScriptToEvaluateOnNewDocument for ${label}`);
      const addResp = await nextResponse(msgId, 3000);
      if (addResp) console.log(`  Response (${label}):`, JSON.stringify(addResp).slice(0, 200));

      msgId++;
      ws.send(JSON.stringify({
        id: msgId,
        method: "Runtime.evaluate",
        params: { expression: source, returnByValue: false },
      }));
      console.log(`Also sent immediate Runtime.evaluate for ${label}`);
      const evalResp = await nextResponse(msgId, 10_000);
      const err = runtimeEvalError(evalResp);
      if (err) {
        console.log(`  ERROR (${label}): ${err.slice(0, 500)}`);
        throw new Error(`Injection failed for ${label}: ${err.slice(0, 300)}`);
      }
      console.log(`  Eval OK (${label})`);
    }

    console.log("Injection commands sent successfully.");
    console.log("Explodex SDK + plugins should now be active (and on future loads).");
  } finally {
    ws.close();
  }
}

async function main(): Promise<void> {
  if (!(await waitForPort(HOST, PORT))) process.exit(1);

  const sdkPath = findSdkPath();
  if (!sdkPath) {
    console.error("ERROR: Could not find explodex-sdk.js");
    console.error("Set EXPLODEX_SDK_PATH or place explodex-sdk.js next to the injector.");
    process.exit(1);
  }

  const sdkSource = readFileSync(sdkPath, "utf-8");
  console.log(`Loaded SDK (${sdkSource.length} bytes) from ${sdkPath}`);

  const pluginEntries = discoverPlugins();
  const catalogSource = buildCatalogBootstrap(pluginEntries);
  const sources: Array<[string, string]> = [
    ["explodex-sdk.js", sdkSource],
    ["explodex-plugin-catalog.js", catalogSource],
  ];
  for (const plugin of pluginEntries) {
    console.log(`Cataloged plugin ${plugin.id} (${plugin.path})`);
  }
  if (!pluginEntries.length) console.log("No plugins found (set EXPLODEX_PLUGINS or add plugins/<id>/)");

  const injected = new Set<string>();
  let firstInjectionAt: number | null = null;
  let attempt = 0;

  while (firstInjectionAt == null || Date.now() - firstInjectionAt < TARGET_WATCH_MS) {
    const targets = await getTargets();
    const pages = injectablePages(targets);

    if (!pages.length && firstInjectionAt == null) {
      if (attempt >= 20) break;
      console.log(`Waiting for renderer page... (${attempt})`);
      attempt++;
      await Bun.sleep(800);
      continue;
    }

    for (const page of pages) {
      const wsUrl = page.webSocketDebuggerUrl;
      if (!wsUrl || injected.has(wsUrl)) continue;

      console.log(`Found renderer page: ${targetLabel(page)}`);
      console.log(`Connecting to ${wsUrl}`);
      if (!(await waitForRendererReady(wsUrl))) {
        console.log("WARN: injecting anyway — renderer readiness probe timed out");
      }
      await injectSourcesViaCdp(wsUrl, sources);
      injected.add(wsUrl);
      firstInjectionAt ??= Date.now();
    }

    if (TARGET_WATCH_MS <= 0) break;
    await Bun.sleep(800);
  }

  if (!injected.size) {
    console.error("Could not find a suitable page target.");
    console.error("Make sure Codex is fully started and try again.");
    process.exit(1);
  }

  console.log(`Injected ${injected.size} renderer target(s).`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
