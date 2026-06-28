import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const REGISTRY_URL = "https://registry.npmjs.org/explodex/latest";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function getUpdateCachePath(home = homedir()) { return join(home, ".explodex", "update-check.json"); }

export function isNewerVersion(latest, current) {
  const parse = (version) => version.replace(/^v/, "").split("-")[0].split(".").map((part) => Number(part) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

export async function readUpdateCache(home = homedir()) {
  try { return JSON.parse(await readFile(getUpdateCachePath(home), "utf8")); } catch { return null; }
}

export async function refreshUpdateCache({ home = homedir(), now = Date.now(), fetchImpl = fetch } = {}) {
  const response = await fetchImpl(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const data = await response.json();
  if (typeof data.version !== "string") return null;
  const entry = { checkedAt: now, latest: data.version };
  await mkdir(join(home, ".explodex"), { recursive: true });
  await writeFile(getUpdateCachePath(home), `${JSON.stringify(entry)}\n`);
  return entry;
}

export async function notifyFromCache(currentVersion, { home = homedir(), now = Date.now(), spawnImpl = spawn, cliPath } = {}) {
  const cache = await readUpdateCache(home);
  if (cache && isNewerVersion(cache.latest, currentVersion)) {
    console.error(`explodex update available: ${currentVersion} → ${cache.latest}. Run: explodex update`);
  }
  if (!cache || now - cache.checkedAt >= CHECK_INTERVAL_MS) {
    const child = spawnImpl(process.execPath, [cliPath, "--check-update"], { detached: true, stdio: "ignore", env: { ...process.env, HOME: home } });
    child.unref();
  }
}
