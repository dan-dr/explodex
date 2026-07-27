import { resolve } from "node:path";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import {
  loadPluginsState,
  sourceLabel,
} from "./install-state.ts";
import type { ReviewArtifact } from "./review-protocol.ts";

export type PendingReviewMetadataResult =
  | {
      ok: true;
      pending: ReviewArtifact[];
      invalid: Array<{
        id: string;
        version: string;
        payloadSha256: string;
        code: string;
        message: string;
      }>;
      sourceDelivered: false;
      stateChanged: false;
    }
  | {
      ok: false;
      code: string;
      message: string;
      sourceDelivered: false;
      stateChanged: false;
    };

function compare(left: ReviewArtifact, right: ReviewArtifact): number {
  return left.id < right.id
    ? -1
    : left.id > right.id
      ? 1
      : left.version < right.version
        ? -1
        : left.version > right.version
          ? 1
          : left.payloadSha256 < right.payloadSha256
            ? -1
            : left.payloadSha256 > right.payloadSha256
              ? 1
              : 0;
}

export async function loadPendingReviewMetadata(options: {
  explodexHome: string;
  signal?: AbortSignal;
}): Promise<PendingReviewMetadataResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "operation.interrupted",
      message: "Plugin review was interrupted before metadata validation.",
      sourceDelivered: false,
      stateChanged: false,
    };
  }
  const home = resolve(options.explodexHome);
  const loaded = await loadPluginsState({ explodexHome: home });
  if (loaded.status !== "valid") {
    return {
      ok: false,
      code: "plugin.state.invalid",
      message:
        "Plugin review requires a valid authoritative plugins.json state. Run an explicit refresh to recover pending artifacts safely.",
      sourceDelivered: false,
      stateChanged: false,
    };
  }
  const pending: ReviewArtifact[] = [];
  const invalid: Array<{
    id: string;
    version: string;
    payloadSha256: string;
    code: string;
    message: string;
  }> = [];
  for (const id of Object.keys(loaded.state.plugins).sort()) {
    const record = loaded.state.plugins[id]!;
    for (const identity of record.pendingReview) {
      if (options.signal?.aborted) {
        return {
          ok: false,
          code: "operation.interrupted",
          message: "Plugin review was interrupted before metadata validation completed.",
          sourceDelivered: false,
          stateChanged: false,
        };
      }
      const installed = record.installed.find((candidate) =>
        candidate.version === identity.version &&
        candidate.payloadSha256 === identity.payloadSha256
      );
      if (installed === undefined) continue;
      const artifactPath = resolve(home, installed.relativePath);
      const validated = await validateInstallablePayloadDir(artifactPath, {
        source: "directory",
        expectedIdentity: {
          id,
          version: identity.version,
          payloadSha256: identity.payloadSha256,
        },
      });
      if (!validated.ok) {
        invalid.push({
          id,
          version: identity.version,
          payloadSha256: identity.payloadSha256,
          code: validated.code,
          message: validated.message,
        });
        continue;
      }
      pending.push({
        id,
        displayName: validated.displayName,
        description: validated.description,
        version: identity.version,
        payloadSha256: identity.payloadSha256,
        sdkRange: validated.sdkRange,
        sourceLabel: sourceLabel(installed.source),
      });
    }
  }
  return {
    ok: true,
    pending: [...new Map(
      pending.map((artifact) => [
        `${artifact.id}\0${artifact.version}\0${artifact.payloadSha256}`,
        artifact,
      ]),
    ).values()].sort(compare),
    invalid,
    sourceDelivered: false,
    stateChanged: false,
  };
}
