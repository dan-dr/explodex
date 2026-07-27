import { readFile, stat } from "node:fs/promises";
import type { PluginUpdateRecommendation } from "./update-transaction.ts";

const MAX_RECOMMENDATION_BYTES = 1_048_576;

export async function loadPluginUpdateRecommendations(
  path: string,
): Promise<readonly unknown[]> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_RECOMMENDATION_BYTES) {
    throw new Error(
      "Configured update recommendation snapshot is not one bounded regular file.",
    );
  }
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Update recommendation snapshot is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
      ["recommendations", "schemaVersion"].sort().join("\0") ||
    record["schemaVersion"] !== 1 ||
    !Array.isArray(record["recommendations"])
  ) {
    throw new Error("Update recommendation snapshot is malformed.");
  }
  return record["recommendations"];
}

export async function fetchSelectedPluginUpdateArchive(
  recommendation: PluginUpdateRecommendation,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const url = new URL(recommendation.artifactUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Selected update artifact URL must use HTTP or HTTPS.");
  }
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Selected update artifact fetch failed with HTTP ${response.status}.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
