#!/usr/bin/env node
/**
 * Required Node-LTS package smoke. Packs the actual CLI candidate into an
 * isolated external fixture, then imports its public runtime under Node 22 and
 * Node 24 with Bun absent from PATH. A missing required runtime is a failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = join(root, "packages", "cli");
const sdkRoot = join(root, "packages", "sdk");
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
  const fixtureRoot = join(scratch, "fixture");
  const packageRoot = join(fixtureRoot, "node_modules", "explodex");
  const npmCache = join(scratch, "npm-cache");
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(fixtureRoot, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
  ]);
  const pack = (packageRoot, label) => {
    const packed = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--pack-destination",
        packRoot,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
      },
    );
    if (packed.status !== 0) {
      throw new Error(`${label} npm pack failed:\n${packed.stderr}`);
    }
    const packResult = JSON.parse(packed.stdout);
    const tarball = packResult[0]?.filename;
    if (typeof tarball !== "string") {
      throw new Error(`${label} npm pack returned no tarball filename`);
    }
    return join(packRoot, tarball);
  };
  const sdkTarball = pack(sdkRoot, "SDK");
  const cliTarball = pack(cliRoot, "CLI");
  const packDependency = async (packageRoot, name) => {
    const stageRoot = join(packRoot, `${name.replaceAll("/", "-").replaceAll("@", "")}-stage`);
    const tarball = join(packRoot, `${name.replaceAll("/", "-").replaceAll("@", "")}.tgz`);
    await mkdir(stageRoot, { recursive: true });
    await cp(packageRoot, join(stageRoot, "package"), {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
    });
    const archived = spawnSync(
      "tar",
      ["-czf", tarball, "-C", stageRoot, "package"],
      { encoding: "utf8" },
    );
    await rm(stageRoot, { recursive: true, force: true });
    if (archived.status !== 0) {
      throw new Error(`${name} dependency pack failed:\n${archived.stderr}`);
    }
    return tarball;
  };
  const acornRoot = realpathSync(join(root, "node_modules", "acorn"));
  const esbuildRoot = realpathSync(join(root, "node_modules", "esbuild"));
  const esbuildPlatformName = `@esbuild/${process.platform}-${process.arch}`;
  const esbuildPlatformRoot = join(
    dirname(esbuildRoot),
    "@esbuild",
    `${process.platform}-${process.arch}`,
  );
  const acornTarball = await packDependency(acornRoot, "acorn");
  const esbuildTarball = await packDependency(esbuildRoot, "esbuild");
  const esbuildPlatformTarball = await packDependency(
    esbuildPlatformRoot,
    esbuildPlatformName,
  );
  await writeFile(join(fixtureRoot, "package.json"), `${JSON.stringify({
    name: "explodex-node-lts-smoke",
    private: true,
    type: "module",
    dependencies: {
      "@explodex/sdk": `file:${sdkTarball}`,
      explodex: `file:${cliTarball}`,
      acorn: `file:${acornTarball}`,
      esbuild: `file:${esbuildTarball}`,
      [esbuildPlatformName]: `file:${esbuildPlatformTarball}`,
    },
  }, null, 2)}\n`);
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--offline",
    ],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(scratch, "install-home"),
        NPM_CONFIG_CACHE: npmCache,
        npm_config_ignore_scripts: "true",
        npm_config_offline: "true",
        npm_config_registry: "http://127.0.0.1:9/",
      },
    },
  );
  if (installed.status !== 0) {
    throw new Error(`SDK/CLI scripts-disabled install failed:\n${installed.stderr}`);
  }

  const probe = join(scratch, "fixture", "probe.mjs");
  await writeFile(probe, `
import { LOCK_ACQUISITION_BOUND_MS, createSystemRuntimeClock } from "explodex/runtime";
import { roleEndpoint } from "explodex/host";
import { createNodeCdpAdapter, selectExactPageAndContext } from "explodex/cdp";
import {
  createDisabledPhase0Contract,
  gateDevelopmentLifecycleMutation,
  ownershipFromLayoutOnly,
  resolveDefaultDevRoot,
} from "explodex/dev";
const bunAbsent = !(process.env.PATH || "").split(":").some((part) => part.toLowerCase().includes("bun"));
if (!bunAbsent) throw new Error("Bun unexpectedly present in runtime PATH");
if (LOCK_ACQUISITION_BOUND_MS !== 2000) throw new Error("Unexpected lock bound");
if (roleEndpoint("main").port !== 9333 || roleEndpoint("development").port !== 9444) throw new Error("Unexpected role endpoint");
const defaultDevRoot = resolveDefaultDevRoot({ osHome: process.env.HOME || "/tmp" });
if (!defaultDevRoot.endsWith("/.explodex/dev/plugin-dev")) throw new Error("Unexpected default development root");
const disabledPhase0 = createDisabledPhase0Contract({ appBuild: "5628" });
const blockedStart = gateDevelopmentLifecycleMutation({ operation: "dev-start", contract: disabledPhase0 });
if (blockedStart.allowed) throw new Error("Disabled Phase 0 must block development lifecycle mutation");
if (ownershipFromLayoutOnly({
  rootPath: defaultDevRoot,
  electronUserDataPath: defaultDevRoot + "/electron-user-data",
  codexHomePath: defaultDevRoot + "/codex-home",
  explodexStatePath: defaultDevRoot + "/explodex-state",
  logsPath: defaultDevRoot + "/logs",
  locksPath: defaultDevRoot + "/locks",
  statePath: defaultDevRoot + "/state.json",
  phase0ContractPath: defaultDevRoot + "/explodex-state/phase0-launch-contract.json",
}).owned) throw new Error("Layout paths must never grant ownership");
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
    const runtimePath = `${dirname(runtime.binary)}:${systemPath}`;
    const bin = join(fixtureRoot, "node_modules", ".bin", "explodex");
    const runCli = (args) => spawnSync(runtime.binary, [bin, ...args], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        PATH: runtimePath,
        HOME: join(scratch, `home-${runtime.label.replace(" ", "-")}`),
        npm_config_cache: join(scratch, `cache-${runtime.label.replace(" ", "-")}`),
      },
    });
    const help = runCli(["--help"]);
    if (help.status !== 0 || !help.stdout.includes("/Applications/ChatGPT.app")) {
      throw new Error(`${runtime.label} packed CLI help failed:\n${help.stderr}\n${help.stdout}`);
    }
    for (const args of [
      ["--json", "--version"],
      ["--json", "host", "inspect"],
      ["--json", "compatibility", "report"],
      ["--json", "definitely-not-a-command"],
    ]) {
      const result = runCli(args);
      const parsed = JSON.parse(result.stdout.trim());
      if (parsed.schemaVersion !== 1 || typeof parsed.operation !== "string") {
        throw new Error(`${runtime.label} emitted an invalid CLI envelope`);
      }
    }
    const sdkImport = spawnSync(
      runtime.binary,
      ["-e", "import('@explodex/sdk').then((sdk)=>{if(typeof sdk.definePlugin!=='function'||typeof sdk.SDK_VERSION!=='string')process.exit(1)})"],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          PATH: runtimePath,
          HOME: join(scratch, `home-${runtime.label.replace(" ", "-")}`),
        },
      },
    );
    if (sdkImport.status !== 0) {
      throw new Error(`${runtime.label} packed SDK import failed:\n${sdkImport.stderr}`);
    }
    const result = spawnSync(runtime.binary, [probe], {
      cwd: dirname(probe),
      encoding: "utf8",
      env: {
        PATH: runtimePath,
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
