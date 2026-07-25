#!/usr/bin/env node
/**
 * Required Node-LTS package smoke. Packs the actual CLI candidate into an
 * isolated external fixture, then imports its public runtime under Node 22 and
 * Node 24 with Bun absent from PATH. A missing required runtime is a failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = join(root, "packages", "cli");
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function miseNodeBinary(major) {
  const result = spawnSync("/usr/bin/env", ["mise", "where", `node@${major}`], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return root.length > 0 ? join(root, "bin", "node") : null;
}

function majorOf(binary) {
  const result = spawnSync(binary, ["-p", "Number(process.versions.node.split('.')[0])"], {
    encoding: "utf8",
    env: { PATH: systemPath },
  });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function requiredNode(major) {
  const override = process.env[`EXPLODEX_NODE_${major}_BIN`];
  const candidates = [
    override,
    process.execPath,
    miseNodeBinary(major),
    `/opt/homebrew/opt/node@${major}/bin/node`,
    `/usr/local/opt/node@${major}/bin/node`,
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate) && majorOf(candidate) === major) return candidate;
  }
  throw new Error(
    `Missing required Node ${major} runtime. Set EXPLODEX_NODE_${major}_BIN to a Node ${major} executable.`,
  );
}

const runtimes = [
  { label: "Node 22", binary: requiredNode(22) },
  { label: "Node 24", binary: requiredNode(24) },
];
const scratch = await mkdtemp(join(tmpdir(), "explodex-node-lts-smoke-"));
try {
  const packRoot = join(scratch, "pack");
  const packageRoot = join(scratch, "fixture", "node_modules", "explodex");
  const npmCache = join(scratch, "npm-cache");
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
  ]);
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
    cwd: cliRoot,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });
  if (packed.status !== 0) throw new Error(`CLI npm pack failed:\n${packed.stderr}`);
  const packResult = JSON.parse(packed.stdout);
  const tarball = packResult[0]?.filename;
  if (typeof tarball !== "string") throw new Error("CLI npm pack returned no tarball filename");
  const extracted = spawnSync("tar", [
    "-xzf",
    join(packRoot, tarball),
    "-C",
    packageRoot,
    "--strip-components=1",
  ], { encoding: "utf8", env: { PATH: systemPath } });
  if (extracted.status !== 0) throw new Error(`CLI tar extraction failed:\n${extracted.stderr}`);

  const probe = join(scratch, "fixture", "probe.mjs");
  await writeFile(probe, `
import { LOCK_ACQUISITION_BOUND_MS, createSystemRuntimeClock } from "explodex/runtime";
import { roleEndpoint } from "explodex/host";
import { createNodeCdpAdapter, selectExactPageAndContext } from "explodex/cdp";
const bunAbsent = !(process.env.PATH || "").split(":").some((part) => part.toLowerCase().includes("bun"));
if (!bunAbsent) throw new Error("Bun unexpectedly present in runtime PATH");
if (LOCK_ACQUISITION_BOUND_MS !== 2000) throw new Error("Unexpected lock bound");
if (roleEndpoint("main").port !== 9333 || roleEndpoint("development").port !== 9444) throw new Error("Unexpected role endpoint");
const selected = selectExactPageAndContext({
  targets: [{ id: "PAGE", type: "page", url: "app://-/index.html", title: "ChatGPT" }],
  contextsByTarget: { PAGE: [{ id: 7, uniqueId: "unique-7", targetId: "PAGE", frameId: "FRAME-7", isDefault: true, origin: "app://-", name: "" }] },
});
if (selected.kind !== "selected" || selected.context.uniqueId !== "unique-7") throw new Error("Packed CDP selector failed");

class SmokeWebSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = SmokeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(raw) {
    const request = JSON.parse(raw);
    const message = (payload) => queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })));
    if (request.method === "Runtime.enable") {
      message({ method: "Runtime.executionContextCreated", params: { context: { id: 17, uniqueId: "unique-context-17", origin: "app://-", name: "", auxData: { isDefault: true, frameId: "FRAME-17" } } } });
      message({ id: request.id, result: {} });
      return;
    }
    if (request.method === "Runtime.evaluate" && request.params.expression === "throw") {
      message({ id: request.id, result: { result: { type: "undefined" }, exceptionDetails: { text: "fixture" } } });
      return;
    }
    if (request.method === "Runtime.evaluate") {
      if (request.params.uniqueContextId !== "unique-context-17" || "contextId" in request.params) throw new Error("Packed adapter used unsafe context identity");
      message({ id: request.id, result: { result: { type: "string", value: "ok" } } });
      return;
    }
    message({ id: request.id, result: {} });
  }
  close() {
    setTimeout(() => {
      this.readyState = SmokeWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }, 15);
  }
}
globalThis.WebSocket = SmokeWebSocket;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/json/list")) return new Response(JSON.stringify([{ id: "PAGE", type: "page", url: "app://-/index.html", title: "ChatGPT", webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/PAGE" }]));
  throw new Error("Unexpected smoke fetch " + url);
};
const cdp = createNodeCdpAdapter();
const targets = await cdp.listTargets({ host: "127.0.0.1", port: 9444 });
const session = await cdp.openTargetSession({ host: "127.0.0.1", port: 9444, target: targets[0] });
const contexts = await session.listExecutionContexts({});
if (contexts[0]?.frameId !== "FRAME-17" || contexts[0]?.targetId !== "PAGE") throw new Error("Packed adapter confused frame and target identity");
const evaluation = await session.evaluate({ executionContextId: contexts[0].id, executionContextUniqueId: contexts[0].uniqueId, expression: "ok" });
if (evaluation.value !== "ok") throw new Error("Packed adapter evaluation failed");
let rejectedException = false;
try {
  await session.evaluate({ executionContextId: contexts[0].id, executionContextUniqueId: contexts[0].uniqueId, expression: "throw" });
} catch (error) {
  rejectedException = String(error).includes("exceptionDetails");
}
if (!rejectedException) throw new Error("Packed adapter accepted Runtime.evaluate exceptionDetails");
const closeStarted = Date.now();
await session.close({ timeoutMs: 250 });
if (Date.now() - closeStarted < 10) throw new Error("Packed adapter did not await websocket closure");
console.log(JSON.stringify({ runtime: process.version, bunAbsent, nowType: typeof createSystemRuntimeClock().nowMs(), mainPort: roleEndpoint("main").port, target: selected.target.id, productionAdapter: true }));
`, { mode: 0o600 });

  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== "explodex") throw new Error("Packed CLI package name mismatch");
  for (const runtime of runtimes) {
    const result = spawnSync(runtime.binary, [probe], {
      cwd: dirname(probe),
      encoding: "utf8",
      env: {
        PATH: systemPath,
        HOME: join(scratch, `home-${runtime.label.replace(" ", "-")}`),
        npm_config_cache: join(scratch, `cache-${runtime.label.replace(" ", "-")}`),
      },
    });
    if (result.status !== 0) {
      throw new Error(`${runtime.label} packed runtime smoke failed:\n${result.stderr}`);
    }
    console.log(`[node-lts-smoke] ${runtime.label}: ${result.stdout.trim()}`);
  }
  console.log(`[node-lts-smoke] package=${packageJson.name}@${packageJson.version}`);
  console.log("[node-lts-smoke] ok");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
