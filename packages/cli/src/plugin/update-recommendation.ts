import { resolve } from "node:path";
import {
  loadPluginsState,
  parseArtifactSource,
  sourceLabel,
  type ArtifactSource,
  type PluginsState,
} from "./install-state.ts";
import type {
  ReviewArtifact,
  ReviewSelectionTuple,
} from "./review-protocol.ts";
import type { PluginPayloadIdentity } from "./approval-transaction.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PluginUpdateRecommendation = {
  artifact: ReviewArtifact;
  archiveSha256: string;
  artifactUrl: string;
  source: Exclude<ArtifactSource, { kind: "local" }>;
};

export type PluginUpdateMetadata = ReviewArtifact & {
  disposition: "will-replace-enabled" | "will-remain-disabled";
  downloadRequired: boolean;
};

export type PluginUpdateListingResult =
  | {
      ok: true;
      recommendations: PluginUpdateMetadata[];
      stateChanged: false;
      sourceDelivered: false;
      downloaded: false;
    }
  | {
      ok: false;
      code: string;
      message: string;
      stateChanged: false;
      sourceDelivered: false;
      downloaded: false;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function isSafeUpdateVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.trim() === value && !/[\u0000-\u001f\u007f/\\]/u.test(value) &&
    value !== "." && value !== "..";
}

function parseReviewArtifact(value: unknown): ReviewArtifact | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "displayName",
      "description",
      "version",
      "payloadSha256",
      "sdkRange",
      "sourceLabel",
    ]) ||
    typeof value.id !== "string" ||
    !PLUGIN_ID_PATTERN.test(value.id) ||
    typeof value.displayName !== "string" ||
    value.displayName.length === 0 ||
    typeof value.description !== "string" ||
    !isSafeUpdateVersion(value.version) ||
    typeof value.payloadSha256 !== "string" ||
    !SHA256_PATTERN.test(value.payloadSha256) ||
    typeof value.sdkRange !== "string" ||
    value.sdkRange.length === 0 ||
    typeof value.sourceLabel !== "string" ||
    value.sourceLabel.length === 0
  ) {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    description: value.description,
    version: value.version,
    payloadSha256: value.payloadSha256,
    sdkRange: value.sdkRange,
    sourceLabel: value.sourceLabel,
  };
}

function parseRecommendation(value: unknown): PluginUpdateRecommendation | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "artifact",
      "archiveSha256",
      "artifactUrl",
      "source",
    ])
  ) {
    return null;
  }
  const artifact = parseReviewArtifact(value.artifact);
  const source = parseArtifactSource(value.source);
  if (
    artifact === null ||
    typeof value.archiveSha256 !== "string" ||
    !SHA256_PATTERN.test(value.archiveSha256) ||
    typeof value.artifactUrl !== "string" ||
    source === null ||
    source.kind === "local" ||
    source.artifactUrl !== value.artifactUrl ||
    artifact.sourceLabel !== sourceLabel(source) ||
    (source.kind === "github" &&
      source.expectedArchiveSha256 !== value.archiveSha256)
  ) {
    return null;
  }
  return {
    artifact,
    archiveSha256: value.archiveSha256,
    artifactUrl: value.artifactUrl,
    source,
  };
}

export function updateIdentityKey(identity: {
  version: string;
  payloadSha256: string;
}): string {
  return `${identity.version}\0${identity.payloadSha256}`;
}

export function fullUpdateIdentityKey(identity: {
  id: string;
  version: string;
  payloadSha256: string;
}): string {
  return `${identity.id}\0${updateIdentityKey(identity)}`;
}

export function compareUpdateIdentity(
  left: PluginPayloadIdentity,
  right: PluginPayloadIdentity,
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 :
    left.version < right.version ? -1 : left.version > right.version ? 1 :
    left.payloadSha256 < right.payloadSha256 ? -1 :
    left.payloadSha256 > right.payloadSha256 ? 1 : 0;
}

export function normalizeUpdateRecommendations(
  values: readonly unknown[],
):
  | { ok: true; values: PluginUpdateRecommendation[] }
  | { ok: false; code: string; message: string } {
  const normalized: PluginUpdateRecommendation[] = [];
  const ids = new Set<string>();
  const tuples = new Set<string>();
  for (const value of values) {
    const recommendation = parseRecommendation(value);
    if (recommendation === null) {
      return {
        ok: false,
        code: "plugin.update.invalid-recommendation",
        message: "Update recommendation metadata is malformed or inconsistent.",
      };
    }
    const key = fullUpdateIdentityKey(recommendation.artifact);
    if (ids.has(recommendation.artifact.id) || tuples.has(key)) {
      return {
        ok: false,
        code: "plugin.update.duplicate-recommendation",
        message:
          "Update recommendations must contain one exact identity per plugin ID.",
      };
    }
    ids.add(recommendation.artifact.id);
    tuples.add(key);
    normalized.push(recommendation);
  }
  normalized.sort((left, right) =>
    compareUpdateIdentity(left.artifact, right.artifact)
  );
  return { ok: true, values: normalized };
}

export function validateUpdateSelection(
  recommendations: readonly PluginUpdateRecommendation[],
  selected: readonly ReviewSelectionTuple[],
):
  | { ok: true; values: PluginPayloadIdentity[] }
  | { ok: false; code: string; message: string } {
  const available = new Set(
    recommendations.map((recommendation) =>
      fullUpdateIdentityKey(recommendation.artifact)
    ),
  );
  const exact = new Set<string>();
  const ids = new Set<string>();
  const values: PluginPayloadIdentity[] = [];
  for (const candidate of selected) {
    if (
      !PLUGIN_ID_PATTERN.test(candidate.id) ||
      !isSafeUpdateVersion(candidate.version) ||
      !SHA256_PATTERN.test(candidate.payloadSha256)
    ) {
      return {
        ok: false,
        code: "plugin.update.invalid-selection",
        message: "Update selection contains a malformed exact identity.",
      };
    }
    const identity = { ...candidate };
    const key = fullUpdateIdentityKey(identity);
    if (exact.has(key)) {
      return {
        ok: false,
        code: "plugin.update.duplicate-selection",
        message: "Update selection repeated one exact identity.",
      };
    }
    if (ids.has(identity.id)) {
      return {
        ok: false,
        code: "plugin.update.multiple-identities",
        message: "Update selection contains two identities for one plugin ID.",
      };
    }
    if (!available.has(key)) {
      return {
        ok: false,
        code: "plugin.update.stale-selection",
        message:
          "Update selection is not an exact member of the current recommendation snapshot.",
      };
    }
    exact.add(key);
    ids.add(identity.id);
    values.push(identity);
  }
  return { ok: true, values: values.sort(compareUpdateIdentity) };
}

export function installedUpdateArtifact(
  state: PluginsState,
  identity: PluginPayloadIdentity,
) {
  return state.plugins[identity.id]?.installed.find((candidate) =>
    updateIdentityKey(candidate) === updateIdentityKey(identity)
  );
}

export function recommendationMetadata(
  state: PluginsState,
  recommendation: PluginUpdateRecommendation,
): PluginUpdateMetadata | null {
  const record = state.plugins[recommendation.artifact.id];
  if (record === undefined || record.installed.length === 0) return null;
  if (
    record.enabled !== null &&
    updateIdentityKey(record.enabled) ===
      updateIdentityKey(recommendation.artifact)
  ) {
    return null;
  }
  return {
    ...recommendation.artifact,
    disposition: record.enabled === null
      ? "will-remain-disabled"
      : "will-replace-enabled",
    downloadRequired:
      !record.installed.some((candidate) =>
        updateIdentityKey(candidate) ===
          updateIdentityKey(recommendation.artifact)
      ),
  };
}

export async function listPluginUpdateRecommendations(options: {
  explodexHome: string;
  recommendations: readonly unknown[];
  signal?: AbortSignal;
}): Promise<PluginUpdateListingResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "operation.interrupted",
      message: "Plugin update listing was interrupted.",
      stateChanged: false,
      sourceDelivered: false,
      downloaded: false,
    };
  }
  const normalized = normalizeUpdateRecommendations(options.recommendations);
  if (!normalized.ok) {
    return {
      ...normalized,
      ok: false,
      stateChanged: false,
      sourceDelivered: false,
      downloaded: false,
    };
  }
  const loaded = await loadPluginsState({
    explodexHome: resolve(options.explodexHome),
  });
  if (loaded.status !== "valid") {
    return {
      ok: false,
      code: "plugin.update.state-invalid",
      message:
        "Update listing requires a valid authoritative plugins.json state.",
      stateChanged: false,
      sourceDelivered: false,
      downloaded: false,
    };
  }
  return {
    ok: true,
    recommendations: normalized.values.flatMap((recommendation) => {
      const metadata = recommendationMetadata(loaded.state, recommendation);
      return metadata === null ? [] : [metadata];
    }),
    stateChanged: false,
    sourceDelivered: false,
    downloaded: false,
  };
}
