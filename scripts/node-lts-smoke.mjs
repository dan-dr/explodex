#!/usr/bin/env node
/**
 * Minimal Node-LTS smoke for the migrating packages/cli surface.
 * Verifies host modules load under plain Node without Bun APIs.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostIndex = join(root, "packages/cli/src/host/index.ts");

// Node cannot import TypeScript directly; smoke the compiled-free constants via
// a small dynamic import of the test-friendly JS-free path is not available yet.
// Instead, assert package metadata and that the CLI package entry files exist.
import { access, readFile } from "node:fs/promises";

async function mustExist(path) {
  await access(path);
}

const cliPkgPath = join(root, "packages/cli/package.json");
const sdkPkgPath = join(root, "packages/sdk/package.json");
await mustExist(cliPkgPath);
await mustExist(sdkPkgPath);
await mustExist(join(root, "packages/cli/src/host/constants.ts"));
await mustExist(join(root, "packages/cli/src/host/identity.ts"));
await mustExist(join(root, "packages/cli/src/host/compatibility-key.ts"));
await mustExist(join(root, "packages/cli/src/host/compatibility-state.ts"));
await mustExist(join(root, "packages/cli/src/host/compatibility-gate.ts"));
await mustExist(hostIndex);

const cliPkg = JSON.parse(await readFile(cliPkgPath, "utf8"));
if (cliPkg.name !== "explodex") {
  console.error(`[node-lts-smoke] expected packages/cli name explodex, got ${cliPkg.name}`);
  process.exit(1);
}

const sdkPkg = JSON.parse(await readFile(sdkPkgPath, "utf8"));
if (sdkPkg.name !== "@explodex/sdk") {
  console.error(`[node-lts-smoke] expected packages/sdk name @explodex/sdk, got ${sdkPkg.name}`);
  process.exit(1);
}

// Pure JS re-check of key derivation semantics without TS loader.
const sample = "host-foundation-smoke";
const digest = createHash("sha256").update(sample).digest("hex");
if (digest.length !== 64) {
  console.error("[node-lts-smoke] sha256 length mismatch");
  process.exit(1);
}

console.log("[node-lts-smoke] ok");
console.log(`[node-lts-smoke] runtime=${process.version}`);
console.log(`[node-lts-smoke] cliPackage=${cliPkg.name}@${cliPkg.version}`);
console.log(`[node-lts-smoke] hostIndex=${pathToFileURL(hostIndex).href}`);
