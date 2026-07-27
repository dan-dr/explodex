import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import { encodeArtifactIdentity } from "./identity-encode.ts";
import { loadArtifactProvenance } from "./install-provenance.ts";
import {
  createEmptyPluginsState,
  loadPluginsState,
  savePluginsStateAtomic,
  sourceLabel,
  type ArtifactSource,
  type InstalledArtifact,
  type PluginsState,
  type PluginsStateLoadResult,
} from "./install-state.ts";
import {
  withPluginStateLock,
  type PluginStateLockFailure,
} from "./state-lock.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { ResidualLockAuthority } from "../runtime/locks.ts";

export type PluginDiscoveryTrigger =
  | "launch"
  | "install"
  | "refresh"
  | "update-check";

export type PendingReviewArtifact = {
  id: string;
  displayName: string;
  description: string;
  version: string;
  payloadSha256: string;
  sdkRange: string;
  sourceLabel: string;
};

export type InvalidInstalledArtifact = {
  id: string;
  path: string;
  code: string;
  message: string;
};

export type PluginDiscoverySuccess = {
  ok: true;
  trigger: PluginDiscoveryTrigger;
  recovery: PluginsStateLoadResult["status"];
  state: PluginsState;
  stateChanged: boolean;
  pending: PendingReviewArtifact[];
  invalid: InvalidInstalledArtifact[];
  newlyRecorded: Array<{
    id: string;
    version: string;
    payloadSha256: string;
  }>;
  rendererRequested: false;
  sourceDelivered: false;
};

export type PluginDiscoveryFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  residualLockAuthority?: ResidualLockAuthority;
  completedDiscovery?: PluginDiscoverySuccess;
};

export type PluginDiscoveryResult =
  | PluginDiscoverySuccess
  | PluginDiscoveryFailure;

type ValidArtifact = {
  id: string;
  displayName: string;
  description: string;
  version: string;
  payloadSha256: string;
  sdkRange: string;
  installedDirectoryName: string;
  relativePath: string;
  prior: InstalledArtifact | null;
  provenance: {
    archiveSha256: string;
    source: ArtifactSource;
    installedAt: string;
  } | null;
};

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function identityKey(identity: {
  version: string;
  payloadSha256: string;
}): string {
  return `${identity.version}\0${identity.payloadSha256}`;
}

function compareIdentity(
  left: { version: string; payloadSha256: string },
  right: { version: string; payloadSha256: string },
): number {
  return left.version < right.version
    ? -1
    : left.version > right.version
      ? 1
      : left.payloadSha256 < right.payloadSha256
        ? -1
        : left.payloadSha256 > right.payloadSha256
          ? 1
          : 0;
}

function comparePending(
  left: PendingReviewArtifact,
  right: PendingReviewArtifact,
): number {
  return left.id < right.id
    ? -1
    : left.id > right.id
      ? 1
      : compareIdentity(left, right);
}

function stateAuthorityJson(state: PluginsState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    plugins: state.plugins,
  });
}

async function readArtifactCandidates(options: {
  explodexHome: string;
  prior: PluginsState | null;
}): Promise<{
  valid: ValidArtifact[];
  invalid: InvalidInstalledArtifact[];
}> {
  const pluginsRoot = join(options.explodexHome, "plugins");
  const valid: ValidArtifact[] = [];
  const invalid: InvalidInstalledArtifact[] = [];
  let idEntries;
  try {
    idEntries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return { valid, invalid };
  }

  for (const idEntry of idEntries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    if (!idEntry.isDirectory() || !PLUGIN_ID_PATTERN.test(idEntry.name)) continue;
    const id = idEntry.name;
    const pluginRoot = join(pluginsRoot, id);
    let artifactEntries;
    try {
      artifactEntries = await readdir(pluginRoot, { withFileTypes: true });
    } catch (error: unknown) {
      invalid.push({
        id,
        path: pluginRoot,
        code: "plugin.discovery.unreadable",
        message: error instanceof Error
          ? error.message
          : "Installed plugin directory is unreadable.",
      });
      continue;
    }

    for (const artifactEntry of artifactEntries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )) {
      if (artifactEntry.name.startsWith(".") || !artifactEntry.isDirectory()) continue;
      const artifactPath = join(pluginRoot, artifactEntry.name);
      const result = await validateInstallablePayloadDir(artifactPath, {
        source: "directory",
        expectedIdentity: { id },
      });
      if (!result.ok) {
        invalid.push({
          id,
          path: artifactPath,
          code: result.code,
          message: result.message,
        });
        continue;
      }
      const encoded = encodeArtifactIdentity({
        id,
        version: result.version,
        payloadSha256: result.payloadSha256,
      });
      if (artifactEntry.name !== encoded.installedDirectoryName) {
        invalid.push({
          id,
          path: artifactPath,
          code: "plugin.discovery.identity-path-mismatch",
          message:
            "Installed artifact directory name does not match its exact payload identity.",
        });
        continue;
      }

      const prior = options.prior?.plugins[id]?.installed.find((item) =>
        item.version === result.version &&
        item.payloadSha256 === result.payloadSha256
      ) ?? null;
      const provenance = await loadArtifactProvenance({
        explodexHome: options.explodexHome,
        id,
        installedDirectoryName: artifactEntry.name,
      });
      const exactProvenance = provenance !== null &&
        provenance.id === id &&
        provenance.version === result.version &&
        provenance.payloadSha256 === result.payloadSha256 &&
        provenance.installedDirectoryName === artifactEntry.name
        ? {
            archiveSha256: provenance.archiveSha256,
            source: provenance.source,
            installedAt: provenance.installedAt,
          }
        : null;
      if (prior === null && exactProvenance === null) {
        invalid.push({
          id,
          path: artifactPath,
          code: "plugin.discovery.provenance-missing",
          message:
            "Valid artifact payload has no exact private installation provenance and cannot be added to authoritative state.",
        });
        continue;
      }
      valid.push({
        id,
        displayName: result.displayName,
        description: result.description,
        version: result.version,
        payloadSha256: result.payloadSha256,
        sdkRange: result.sdkRange,
        installedDirectoryName: artifactEntry.name,
        relativePath: relative(options.explodexHome, artifactPath)
          .split("\\")
          .join("/"),
        prior,
        provenance: exactProvenance,
      });
    }
  }
  return { valid, invalid };
}

function buildReconciledState(options: {
  loaded: PluginsStateLoadResult;
  valid: readonly ValidArtifact[];
  now: string;
}): {
  state: PluginsState;
  newlyRecorded: Array<{
    id: string;
    version: string;
    payloadSha256: string;
  }>;
} {
  const prior = options.loaded.status === "valid"
    ? options.loaded.state
    : createEmptyPluginsState(options.now);
  const next = createEmptyPluginsState(options.now);
  const newlyRecorded: Array<{
    id: string;
    version: string;
    payloadSha256: string;
  }> = [];
  const byId = new Map<string, ValidArtifact[]>();
  for (const artifact of options.valid) {
    const current = byId.get(artifact.id) ?? [];
    current.push(artifact);
    byId.set(artifact.id, current);
  }

  const allIds = new Set([
    ...Object.keys(prior.plugins),
    ...byId.keys(),
  ]);
  for (const id of [...allIds].sort()) {
    const artifacts = (byId.get(id) ?? []).sort(compareIdentity);
    const priorRecord = prior.plugins[id];
    const installedByIdentity = new Map<string, InstalledArtifact>(
      (priorRecord?.installed ?? []).map((artifact) => [
        identityKey(artifact),
        artifact,
      ]),
    );
    for (const artifact of artifacts) {
      if (artifact.prior !== null) continue;
      if (artifact.provenance === null) {
        throw new Error("Reconciliation candidate lost installation provenance.");
      }
      newlyRecorded.push({
        id,
        version: artifact.version,
        payloadSha256: artifact.payloadSha256,
      });
      installedByIdentity.set(identityKey(artifact), {
        version: artifact.version,
        payloadSha256: artifact.payloadSha256,
        archiveSha256: artifact.provenance.archiveSha256,
        relativePath: artifact.relativePath,
        source: artifact.provenance.source,
        installedAt: artifact.provenance.installedAt,
      });
    }
    const installed = [...installedByIdentity.values()].sort(compareIdentity);
    const enabled = priorRecord?.enabled ?? null;
    const priorPending = new Set(
      priorRecord?.pendingReview.map(identityKey) ?? [],
    );
    const priorInstalled = new Set(
      priorRecord?.installed.map(identityKey) ?? [],
    );
    for (const artifact of artifacts) {
      const key = identityKey(artifact);
      if (enabled !== null && key === identityKey(enabled)) continue;
      if (!priorInstalled.has(key)) priorPending.add(key);
    }
    const pendingReview = installed.flatMap((artifact) =>
      priorPending.has(identityKey(artifact))
        ? [{
            version: artifact.version,
            payloadSha256: artifact.payloadSha256,
          }]
        : []
    ).sort(compareIdentity);
    next.plugins[id] = {
      installed: installed.sort(compareIdentity),
      enabled,
      pendingReview,
    };
  }
  return { state: next, newlyRecorded };
}

function pendingMetadata(
  state: PluginsState,
  valid: readonly ValidArtifact[],
): PendingReviewArtifact[] {
  const byIdentity = new Map<string, ValidArtifact>();
  for (const artifact of valid) {
    byIdentity.set(`${artifact.id}\0${identityKey(artifact)}`, artifact);
  }
  const pending: PendingReviewArtifact[] = [];
  for (const id of Object.keys(state.plugins).sort()) {
    const record = state.plugins[id]!;
    for (const identity of record.pendingReview) {
      const artifact = byIdentity.get(`${id}\0${identityKey(identity)}`);
      const installed = record.installed.find((item) =>
        identityKey(item) === identityKey(identity)
      );
      if (artifact === undefined || installed === undefined) continue;
      pending.push({
        id,
        displayName: artifact.displayName,
        description: artifact.description,
        version: identity.version,
        payloadSha256: identity.payloadSha256,
        sdkRange: artifact.sdkRange,
        sourceLabel: sourceLabel(installed.source),
      });
    }
  }
  return pending.sort(comparePending);
}

export async function reconcileInstalledPluginsUnlocked(options: {
  explodexHome: string;
  trigger: PluginDiscoveryTrigger;
  now?: () => string;
  beforeStateMutation?: () => void | Promise<void>;
  signal?: AbortSignal;
  writeState?: (options: {
    explodexHome: string;
    state: PluginsState;
  }) => Promise<void>;
}): Promise<PluginDiscoveryResult> {
  const home = resolve(options.explodexHome);
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "operation.interrupted",
      message: "Plugin discovery was interrupted before reconciliation.",
    };
  }
  const loaded = await loadPluginsState({ explodexHome: home });
  const prior = loaded.status === "valid" ? loaded.state : null;
  const candidates = await readArtifactCandidates({
    explodexHome: home,
    prior,
  });
  const now = options.now?.() ?? new Date().toISOString();
  let reconciled;
  try {
    reconciled = buildReconciledState({
      loaded,
      valid: candidates.valid,
      now,
    });
  } catch (error: unknown) {
    return {
      ok: false,
      code: "plugin.state.reconciliation-failed",
      message: error instanceof Error
        ? error.message
        : "Plugin state reconciliation failed.",
    };
  }
  const changed = loaded.status !== "valid" ||
    stateAuthorityJson(loaded.state) !== stateAuthorityJson(reconciled.state);
  if (!changed && loaded.status === "valid") {
    reconciled.state.updatedAt = loaded.state.updatedAt;
  } else {
    try {
      if (options.signal?.aborted) {
        return {
          ok: false,
          code: "operation.interrupted",
          message:
            "Plugin discovery was interrupted before the authoritative state commit.",
        };
      }
      await options.beforeStateMutation?.();
      if (options.signal?.aborted) {
        return {
          ok: false,
          code: "operation.interrupted",
          message:
            "Plugin discovery was interrupted before the authoritative state commit.",
        };
      }
      await (options.writeState ?? savePluginsStateAtomic)({
        explodexHome: home,
        state: reconciled.state,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        code: "plugin.state.write-failed",
        message: error instanceof Error
          ? error.message
          : "Plugin state commit failed.",
      };
    }
  }

  return {
    ok: true,
    trigger: options.trigger,
    recovery: loaded.status,
    state: reconciled.state,
    stateChanged: changed,
    pending: pendingMetadata(reconciled.state, candidates.valid),
    invalid: candidates.invalid,
    newlyRecorded: reconciled.newlyRecorded,
    rendererRequested: false,
    sourceDelivered: false,
  };
}

function lockFailure(
  result: PluginStateLockFailure<PluginDiscoveryResult>,
): PluginDiscoveryFailure {
  return {
    ok: false,
    code: result.code,
    message: result.message,
    details: result.details,
    ...(result.residual === undefined
      ? {}
      : { residualLockAuthority: result.residual }),
    ...(result.completedValue?.ok !== true
      ? {}
      : { completedDiscovery: result.completedValue }),
  };
}

export async function discoverInstalledPlugins(options: {
  explodexHome: string;
  trigger: PluginDiscoveryTrigger;
  now?: () => string;
  beforeStateMutation?: () => void | Promise<void>;
  writeState?: (options: {
    explodexHome: string;
    state: PluginsState;
  }) => Promise<void>;
  signal?: AbortSignal;
  lockWaitMs?: number;
  runtimeAdapters?: RuntimeAdapters;
  operationId?: string;
}): Promise<PluginDiscoveryResult> {
  const locked = await withPluginStateLock({
    explodexHome: resolve(options.explodexHome),
    operation: `plugin.discovery.${options.trigger}`,
    waitBoundMs: options.lockWaitMs,
    signal: options.signal,
    runtimeAdapters: options.runtimeAdapters,
    operationId: options.operationId,
    work: () => reconcileInstalledPluginsUnlocked(options),
  });
  return locked.ok ? locked.value : lockFailure(locked);
}

export function installedArtifactDirectoryName(path: string): string {
  return basename(path);
}
