#!/usr/bin/env bun
/**
 * Local development entrypoint.
 * 1. Package Explodex.app to dist/
 * 2. Launch it (Codex + CDP injection on port 9333)
 * 3. Start chrome-devtools-mcp for agent/browser inspection
 */

import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { packageApp } from "./package-app.ts";

const ROOT = join(import.meta.dir, "..");
const PORT = Number(process.env.EXPLODEX_DEBUG_PORT ?? "9333");
const HOST = "127.0.0.1";
const BROWSER_URL = `http://${HOST}:${PORT}`;
const APP_PATH = join(ROOT, "dist", "Explodex.app");
const USER_DATA = process.env.EXPLODEX_USER_DATA ?? join(ROOT, ".explodex-user-data");

let mcpProc: Subprocess | null = null;
let shuttingDown = false;

async function runPackage(): Promise<void> {
  console.log("Packaging dist/Explodex.app...");
  await packageApp();
}

async function waitForPort(timeoutMs = 60_000): Promise<void> {
  console.log(`Waiting for debug port ${BROWSER_URL}...`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BROWSER_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log(`Debug port ready: ${BROWSER_URL}`);
        return;
      }
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error(`Timed out waiting for ${BROWSER_URL}`);
}

function startMcp(): Subprocess {
  console.log("Starting chrome-devtools-mcp...");
  const proc = spawn({
    cmd: [
      "npx",
      "-y",
      "chrome-devtools-mcp@latest",
      `--browser-url=${BROWSER_URL}`,
    ],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const prefix = "[chrome-devtools-mcp]";
  const log = (stream: ReadableStream<Uint8Array> | null, fn: typeof console.log) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value).trimEnd();
        if (text) fn(`${prefix} ${text}`);
      }
    })();
  };
  log(proc.stdout, console.log);
  log(proc.stderr, console.error);

  return proc;
}

async function launchApp(): Promise<void> {
  const launcher = join(APP_PATH, "Contents", "MacOS", "Explodex");
  console.log(`Launching ${APP_PATH}`);
  console.log(`User data: ${USER_DATA}`);
  const proc = spawn([launcher], {
    cwd: ROOT,
    env: {
      ...process.env,
      EXPLODEX_USER_DATA: USER_DATA,
      EXPLODEX_DEBUG_PORT: String(PORT),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  // Launcher waits on Codex; dev keeps MCP alive in the foreground.
  proc.exited.catch(() => {});
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (mcpProc) {
    console.log("Stopping chrome-devtools-mcp...");
    mcpProc.kill();
    await mcpProc.exited.catch(() => {});
  }
}

async function main(): Promise<void> {
  process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });

  await runPackage();
  await launchApp();
  await waitForPort();

  mcpProc = startMcp();
  await Bun.sleep(1500);

  console.log("");
  console.log("Explodex dev session is running.");
  console.log(`  App:        ${APP_PATH}`);
  console.log(`  DevTools:   ${BROWSER_URL}/json/list`);
  console.log(`  MCP:        chrome-devtools-mcp -> ${BROWSER_URL}`);
  console.log(`  User data:  ${USER_DATA}`);
  console.log("");
  console.log("Edit sdk/ or plugins/, then run: bun run inject");
  console.log("Press Ctrl+C to stop the MCP helper (Codex keeps running).");

  await mcpProc.exited;
}

if (import.meta.main) {
  main().catch(async (err) => {
    console.error(err);
    await shutdown();
    process.exit(1);
  });
}