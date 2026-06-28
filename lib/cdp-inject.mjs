#!/usr/bin/env bun
// @bun

// scripts/cdp-inject.ts
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, basename, extname } from "path";
import { fileURLToPath } from "url";
var __dirname2 = dirname(fileURLToPath(import.meta.url));
var PORT = Number(process.env.EXPLODEX_DEBUG_PORT ?? "9333");
var HOST = "127.0.0.1";
var TARGET_WATCH_MS = Number(process.env.EXPLODEX_TARGET_WATCH_MS ?? "8000");
var sleep = (milliseconds) => new Promise((resolve2) => setTimeout(resolve2, milliseconds));
function injectorResourceDir() {
  const here = resolve(__dirname2);
  if (!here.startsWith("/$bunfs"))
    return here;
  const exe = process.argv[0];
  return exe ? resolve(dirname(exe)) : here;
}
function findSdkPath() {
  const env = process.env.EXPLODEX_SDK_PATH ?? "";
  const resourceDir = injectorResourceDir();
  const candidates = [
    join(__dirname2, "..", "sdk", "explodex-sdk.js"),
    join(resourceDir, "explodex-sdk.js"),
    join(__dirname2, "explodex-sdk.js"),
    join(process.cwd(), "sdk", "explodex-sdk.js"),
    env
  ];
  for (const cand of candidates) {
    if (cand && existsSync(cand) && statSync(cand).isFile())
      return resolve(cand);
  }
  return null;
}
function findBundledPluginsDir() {
  const env = (process.env.EXPLODEX_BUNDLED_PLUGINS_DIR ?? "").trim();
  if (env) {
    const resolved = resolve(env);
    if (existsSync(resolved) && statSync(resolved).isDirectory())
      return resolved;
  }
  const sdkPath = (process.env.EXPLODEX_SDK_PATH ?? "").trim();
  if (sdkPath) {
    const sibling = join(dirname(resolve(sdkPath)), "plugins");
    if (existsSync(sibling) && statSync(sibling).isDirectory())
      return sibling;
  }
  const here = injectorResourceDir();
  const candidates = [
    join(here, "plugins"),
    join(here, "..", "plugins"),
    join(here, "..", "..", "..", "plugins")
  ];
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isDirectory())
      return resolve(cand);
  }
  return null;
}
function userPluginsDir() {
  const env = (process.env.EXPLODEX_USER_PLUGINS_DIR ?? "").trim();
  if (env)
    return resolve(env);
  return join(homedir(), ".explodex", "plugins");
}
function ensureUserPluginsDir() {
  const dir = userPluginsDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.warn(`WARN: could not read ${path}: ${err}`);
    return {};
  }
}
function parsePluginManifest(source, filename) {
  const manifest = {
    id: basename(filename, extname(filename)),
    name: basename(filename, extname(filename)),
    version: "0.0.0",
    dynamicLoadable: true,
    dynamicUnloadable: true
  };
  const block = source.match(/BC\.plugins\.register\s*\(\s*\{([\s\S]*?)\}\s*,/);
  if (!block)
    return manifest;
  const body = block[1];
  const pick = (key, fallback) => {
    const m = body.match(new RegExp(`${key}\\s*:\\s*['"]([^'"]+)['"]`));
    return m?.[1] ?? fallback;
  };
  const pickBool = (key, fallback) => {
    const m = body.match(new RegExp(`${key}\\s*:\\s*(true|false)`));
    return m ? m[1] === "true" : fallback;
  };
  return {
    id: pick("id", manifest.id),
    name: pick("name", manifest.name),
    version: pick("version", manifest.version),
    dynamicLoadable: pickBool("dynamicLoadable", true),
    dynamicUnloadable: pickBool("dynamicUnloadable", true)
  };
}
function pluginEntryFromFile(path) {
  if (!existsSync(path) || !statSync(path).isFile())
    return null;
  const source = readFileSync(path, "utf-8");
  const parsed = parsePluginManifest(source, basename(path));
  return { ...parsed, source, path };
}
function pluginEntryFromDir(path) {
  const manifestPath = join(path, "plugin.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {};
  const entryName = manifest.entry ?? "index.js";
  const entryPath = join(path, entryName);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    console.warn(`WARN: plugin ${basename(path)} has no entry file at ${entryPath}`);
    return null;
  }
  const scriptNames = Array.isArray(manifest.scripts) ? manifest.scripts.filter((value) => typeof value === "string") : [entryName];
  if (!scriptNames.includes(entryName))
    scriptNames.push(entryName);
  const sources = [];
  for (const scriptName of scriptNames) {
    const scriptPath = resolve(path, scriptName);
    if (!scriptPath.startsWith(`${resolve(path)}/`) || !existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
      console.warn(`WARN: plugin ${basename(path)} has no script at ${scriptPath}`);
      return null;
    }
    sources.push(readFileSync(scriptPath, "utf-8"));
  }
  const source = sources.join(`
;
`);
  const parsed = parsePluginManifest(source, basename(entryPath));
  const id = manifest.id ?? basename(path);
  return {
    ...parsed,
    ...manifest,
    id,
    name: manifest.name ?? id,
    version: manifest.version ?? "0.0.0",
    source,
    path: entryPath
  };
}
function discoverPluginsInDir(pluginsDir) {
  if (!existsSync(pluginsDir) || !statSync(pluginsDir).isDirectory())
    return [];
  const entries = [];
  for (const child of readdirSync(pluginsDir).sort()) {
    const full = join(pluginsDir, child);
    let entry = null;
    if (statSync(full).isDirectory())
      entry = pluginEntryFromDir(full);
    else if (extname(child) === ".js")
      entry = pluginEntryFromFile(full);
    if (entry)
      entries.push(entry);
  }
  return entries;
}
function mergePluginEntries(layers) {
  const byId = new Map;
  const sourceById = new Map;
  for (const { label, dir } of layers) {
    for (const entry of discoverPluginsInDir(dir)) {
      const prev = byId.get(entry.id);
      if (prev) {
        console.warn(`WARN: plugin ${entry.id} from ${label} (${entry.path}) overrides ${sourceById.get(entry.id)}`);
      }
      byId.set(entry.id, entry);
      sourceById.set(entry.id, `${label}:${entry.path}`);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function discoverPlugins() {
  const env = (process.env.EXPLODEX_PLUGINS ?? "").trim();
  if (env) {
    const entries = [];
    for (const raw of env.split(":")) {
      const p = raw.trim();
      if (!p)
        continue;
      const resolved = resolve(p);
      const entry = statSync(resolved).isDirectory() ? pluginEntryFromDir(resolved) : pluginEntryFromFile(resolved);
      if (entry)
        entries.push(entry);
    }
    return entries;
  }
  const layers = [];
  const bundled = findBundledPluginsDir();
  if (bundled)
    layers.push({ label: "bundled", dir: bundled });
  const userDir = ensureUserPluginsDir();
  layers.push({ label: "user", dir: userDir });
  const devDir = (process.env.EXPLODEX_PLUGINS_DIR ?? "").trim();
  if (devDir)
    layers.push({ label: "dev", dir: resolve(devDir) });
  return mergePluginEntries(layers);
}
function findRelaunchScript() {
  const resourceDir = injectorResourceDir();
  const candidates = [
    join(resourceDir, "relaunch.sh"),
    join(__dirname2, "relaunch.sh"),
    join(__dirname2, "..", "templates", "explodex-app", "Contents", "Resources", "relaunch.sh")
  ];
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isFile())
      return resolve(cand);
  }
  return null;
}
function buildCatalogBootstrap(pluginEntries) {
  const catalog = pluginEntries.map(({ path: _path, ...rest }) => rest);
  const relaunch = findRelaunchScript();
  const pathsMeta = {
    userPluginsDir: ensureUserPluginsDir()
  };
  if (relaunch)
    pathsMeta.relaunchScript = `file://${relaunch}`;
  return [
    `window.__EXPLODEX_PLUGIN_CATALOG__ = ${JSON.stringify(catalog)};`,
    `window.__EXPLODEX_PATHS__ = ${JSON.stringify(pathsMeta)};`,
    "if (window.Explodex?.plugins?.initFromCatalog) {",
    "  window.Explodex.plugins.initFromCatalog();",
    "}"
  ].join(`
`);
}
async function waitForPort(host, port, timeout = 30000) {
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
      await sleep(500);
    }
  }
  console.log("Timed out waiting for debugger port.");
  return false;
}
async function getTargets() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch {
    return [];
  }
}
function isInjectablePage(target) {
  if (target.type !== "page" || !target.webSocketDebuggerUrl)
    return false;
  const url = (target.url ?? "").toLowerCase();
  const title = (target.title ?? "").toLowerCase();
  if (url.includes("devtools") || title.includes("devtools"))
    return false;
  return url.includes("codex") || title.includes("codex") || !url.includes("localhost");
}
function injectablePages(targets) {
  const matchingPages = targets.filter(isInjectablePage);
  if (matchingPages.length)
    return matchingPages;
  const pageTargets = targets.filter((t) => t.type === "page");
  return pageTargets.filter((p) => p.webSocketDebuggerUrl && !(p.url ?? "").toLowerCase().includes("devtools"));
}
function targetLabel(target) {
  return target.url || target.title || target.id || "untitled page";
}
var RENDERER_READY_EXPR = `(() => {
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
async function waitForRendererReady(wsUrl, timeout = 45000) {
  console.log("Waiting for renderer UI to mount...");
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeout) {
    try {
      const resp = await cdpRequest(wsUrl, "Runtime.evaluate", {
        expression: RENDERER_READY_EXPR,
        returnByValue: true
      }, 9000 + attempt, 4000);
      const value = resp?.result?.result?.value;
      if (value?.ok) {
        console.log(`Renderer ready (rootChildren=${value.rootChildren}, textLen=${value.textLen}).`);
        return true;
      }
      if (attempt % 5 === 0 && value) {
        console.log(`Renderer not ready yet (state=${value.readyState}, root=${value.rootChildren}, text=${value.textLen})...`);
      }
    } catch (err) {
      if (attempt % 5 === 0)
        console.log(`Renderer readiness check failed: ${err}`);
    }
    attempt++;
    await sleep(500);
  }
  console.log("Timed out waiting for renderer UI to mount.");
  return false;
}
async function cdpRequest(wsUrl, method, params, reqId = 1, timeoutMs = 5000) {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve2, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve2();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket error"));
      };
    });
    const payload = JSON.stringify({ id: reqId, method, params });
    const response = await new Promise((resolve2) => {
      const timer = setTimeout(() => resolve2(null), timeoutMs);
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        try {
          resolve2(JSON.parse(String(ev.data)));
        } catch {
          resolve2(null);
        }
      };
      ws.send(payload);
    });
    return response;
  } finally {
    ws.close();
  }
}
function runtimeEvalError(resp) {
  if (!resp)
    return "no CDP response";
  const result = resp.result?.result;
  if (result?.subtype === "error")
    return result.description ?? result.className ?? "runtime error";
  if (resp.error)
    return resp.error.message ?? "CDP error";
  return null;
}
async function injectSourcesViaCdp(wsUrl, sources) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve2, reject) => {
    ws.onopen = () => resolve2();
    ws.onerror = () => reject(new Error("WebSocket connect failed"));
  });
  try {
    console.log("WebSocket connected.");
    let msgId = 0;
    const nextResponse = (id, timeoutMs) => new Promise((resolve2) => {
      const timer = setTimeout(() => resolve2(null), timeoutMs);
      const handler = (ev) => {
        try {
          const data = JSON.parse(String(ev.data));
          if (data.id === id) {
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve2(data);
          }
        } catch {}
      };
      ws.addEventListener("message", handler);
    });
    for (const [label, source] of sources) {
      msgId++;
      ws.send(JSON.stringify({
        id: msgId,
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source, world: "MAIN" }
      }));
      console.log(`Sent addScriptToEvaluateOnNewDocument for ${label}`);
      const addResp = await nextResponse(msgId, 3000);
      if (addResp)
        console.log(`  Response (${label}):`, JSON.stringify(addResp).slice(0, 200));
      msgId++;
      ws.send(JSON.stringify({
        id: msgId,
        method: "Runtime.evaluate",
        params: { expression: source, returnByValue: false }
      }));
      console.log(`Also sent immediate Runtime.evaluate for ${label}`);
      const evalResp = await nextResponse(msgId, 1e4);
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
async function main() {
  if (!await waitForPort(HOST, PORT))
    process.exit(1);
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
  const sources = [
    ["explodex-plugin-catalog.js", catalogSource],
    ["explodex-sdk.js", sdkSource]
  ];
  for (const plugin of pluginEntries) {
    console.log(`Cataloged plugin ${plugin.id} (${plugin.path})`);
  }
  if (!pluginEntries.length)
    console.log("No plugins found (set EXPLODEX_PLUGINS or add plugins/<id>/)");
  const injected = new Set;
  let firstInjectionAt = null;
  let attempt = 0;
  while (firstInjectionAt == null || Date.now() - firstInjectionAt < TARGET_WATCH_MS) {
    const targets = await getTargets();
    const pages = injectablePages(targets);
    if (!pages.length && firstInjectionAt == null) {
      if (attempt >= 20)
        break;
      console.log(`Waiting for renderer page... (${attempt})`);
      attempt++;
      await sleep(800);
      continue;
    }
    for (const page of pages) {
      const wsUrl = page.webSocketDebuggerUrl;
      if (!wsUrl || injected.has(wsUrl))
        continue;
      console.log(`Found renderer page: ${targetLabel(page)}`);
      console.log(`Connecting to ${wsUrl}`);
      if (!await waitForRendererReady(wsUrl)) {
        console.log("WARN: injecting anyway \u2014 renderer readiness probe timed out");
      }
      await injectSourcesViaCdp(wsUrl, sources);
      injected.add(wsUrl);
      firstInjectionAt ??= Date.now();
    }
    if (TARGET_WATCH_MS <= 0)
      break;
    await sleep(800);
  }
  if (!injected.size) {
    console.error("Could not find a suitable page target.");
    console.error("Make sure Codex is fully started and try again.");
    process.exit(1);
  }
  console.log(`Injected ${injected.size} renderer target(s).`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
