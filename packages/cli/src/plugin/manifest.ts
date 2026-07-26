/**
 * Exact schemaVersion-1 plugin.json generation.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLifecycle } from "@explodex/sdk";
import { compareBytewise } from "./dist-files.ts";

export type PluginManifestV1 = {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: string;
  description: string;
  sdkRange: string;
  lifecycle: PluginLifecycle;
  entry: "index.js";
  assets: string[];
};

const MANIFEST_KEY_ORDER = [
  "schemaVersion",
  "id",
  "version",
  "displayName",
  "description",
  "sdkRange",
  "lifecycle",
  "entry",
  "assets",
] as const;

export function buildPluginManifest(options: {
  id: string;
  version: string;
  displayName: string;
  description: string;
  sdkRange: string;
  lifecycle: PluginLifecycle;
  /** Installable asset paths (assets/...), sorted if not already. */
  assets: readonly string[];
}): PluginManifestV1 {
  const assets = [...options.assets].sort(compareBytewise);
  return {
    schemaVersion: 1,
    id: options.id,
    version: options.version,
    displayName: options.displayName,
    description: options.description,
    sdkRange: options.sdkRange,
    lifecycle: options.lifecycle,
    entry: "index.js",
    assets,
  };
}

/** Deterministic JSON with stable key order and trailing newline. */
export function serializePluginManifest(manifest: PluginManifestV1): string {
  const ordered: Record<string, unknown> = {};
  for (const key of MANIFEST_KEY_ORDER) {
    ordered[key] = manifest[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writePluginManifest(
  stagingDir: string,
  manifest: PluginManifestV1,
): Promise<string> {
  const text = serializePluginManifest(manifest);
  await writeFile(join(stagingDir, "plugin.json"), text, "utf8");
  return text;
}

export function parsePluginManifest(raw: unknown):
  | { ok: true; manifest: PluginManifestV1 }
  | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "plugin.json must be an object" };
  }
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort(compareBytewise);
  const expected = [...MANIFEST_KEY_ORDER].sort(compareBytewise);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { ok: false, message: "plugin.json has unexpected or missing fields" };
  }
  if (value.schemaVersion !== 1) {
    return { ok: false, message: "plugin.json schemaVersion must be 1" };
  }
  if (value.entry !== "index.js") {
    return { ok: false, message: 'plugin.json entry must be "index.js"' };
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return { ok: false, message: "plugin.json id is invalid" };
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    return { ok: false, message: "plugin.json version is invalid" };
  }
  if (typeof value.displayName !== "string" || value.displayName.length === 0) {
    return { ok: false, message: "plugin.json displayName is invalid" };
  }
  if (typeof value.description !== "string") {
    return { ok: false, message: "plugin.json description is invalid" };
  }
  if (typeof value.sdkRange !== "string" || value.sdkRange.length === 0) {
    return { ok: false, message: "plugin.json sdkRange is invalid" };
  }
  if (
    value.lifecycle !== "dynamic" &&
    value.lifecycle !== "renderer-start" &&
    value.lifecycle !== "app-start"
  ) {
    return { ok: false, message: "plugin.json lifecycle is invalid" };
  }
  if (
    !Array.isArray(value.assets) ||
    !value.assets.every((item) => typeof item === "string")
  ) {
    return { ok: false, message: "plugin.json assets must be an array of strings" };
  }
  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      id: value.id,
      version: value.version,
      displayName: value.displayName,
      description: value.description,
      sdkRange: value.sdkRange,
      lifecycle: value.lifecycle,
      entry: "index.js",
      assets: value.assets as string[],
    },
  };
}
