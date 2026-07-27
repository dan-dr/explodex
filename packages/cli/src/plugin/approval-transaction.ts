import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInertRegistrationHarness } from "@explodex/sdk/testing";
import { evaluateSdkCompatibility, SDK_VERSION } from "../sdk/compatibility.ts";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import { scanBrowserSafeIife } from "./browser-scan.ts";
import {
  computePayloadSha256,
  parseChecksumsJson,
  type ChecksumsManifest,
} from "./checksums.ts";
import {
  compareBytewise,
  isInstallableRelativePath,
  listPayloadTreeEntries,
  sha256Hex,
} from "./dist-files.ts";
import {
  loadPluginsState,
  savePluginsStateAtomic,
  type InstalledArtifact,
  type PluginsState,
} from "./install-state.ts";
import { parsePluginManifest, type PluginManifestV1 } from "./manifest.ts";
import type { ReviewSelectionTuple } from "./review-protocol.ts";
import { validatePluginSourceMapV3 } from "./source-map.ts";
import {
  withPluginStateLock,
  type PluginStateLockFailure,
} from "./state-lock.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { ResidualLockAuthority } from "../runtime/locks.ts";

export type PluginPayloadIdentity = {
  id: string;
  version: string;
  payloadSha256: string;
};

export type PluginPayloadSnapshot = {
  readonly identity: PluginPayloadIdentity;
  readonly manifest: PluginManifestV1;
  readonly files: readonly string[];
  read(path: string): Uint8Array;
};

export type PluginApprovalAdapters = {
  beforeSelectedRevalidation?(): void | Promise<void>;
  beforeStateCommit?(): void | Promise<void>;
  afterStateCommitBeforeSnapshot?(): void | Promise<void>;
  afterSnapshot?(): void | Promise<void>;
  readSnapshotFile?(path: string): Promise<Uint8Array>;
  writeState?(options: {
    explodexHome: string;
    state: PluginsState;
  }): Promise<void>;
};

export type PluginApprovalSuccess = {
  ok: true;
  operationId: string;
  selected: PluginPayloadIdentity[];
  stateCommitted: boolean;
  authorityChanged: boolean;
  snapshots: PluginPayloadSnapshot[];
  previousIntents: Array<{
    id: string;
    intent: Omit<PluginPayloadIdentity, "id"> | null;
  }>;
  residualLockAuthority?: ResidualLockAuthority;
};

export type PluginApprovalFailure = {
  ok: false;
  operationId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  selected: PluginPayloadIdentity[];
  stateCommitted: boolean;
  authorityChanged: boolean;
  snapshots: PluginPayloadSnapshot[];
  previousIntents: Array<{
    id: string;
    intent: Omit<PluginPayloadIdentity, "id"> | null;
  }>;
  residualLockAuthority?: ResidualLockAuthority;
};

export type PluginApprovalResult =
  | PluginApprovalSuccess
  | PluginApprovalFailure;

type ResolvedSelection = {
  identity: PluginPayloadIdentity;
  installed: InstalledArtifact;
  artifactPath: string;
};

function identityKey(identity: {
  version: string;
  payloadSha256: string;
}): string {
  return `${identity.version}\0${identity.payloadSha256}`;
}

function fullIdentityKey(identity: PluginPayloadIdentity): string {
  return `${identity.id}\0${identityKey(identity)}`;
}

function interrupted(): PluginApprovalFailure {
  return {
    ok: false,
    operationId: "plugin-approval",
    code: "operation.interrupted",
    message: "Plugin approval was interrupted.",
    selected: [],
    stateCommitted: false,
    authorityChanged: false,
    snapshots: [],
    previousIntents: [],
  };
}

function failure(options: {
  operationId?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  selected?: PluginPayloadIdentity[];
  stateCommitted?: boolean;
  snapshots?: PluginPayloadSnapshot[];
  previousIntents?: PluginApprovalFailure["previousIntents"];
  residualLockAuthority?: ResidualLockAuthority;
}): PluginApprovalFailure {
  return {
    ok: false,
    operationId: options.operationId ?? "plugin-approval",
    code: options.code,
    message: options.message,
    ...(options.details === undefined ? {} : { details: options.details }),
    selected: options.selected ?? [],
    stateCommitted: options.stateCommitted ?? false,
    authorityChanged: options.stateCommitted ?? false,
    snapshots: options.snapshots ?? [],
    previousIntents: options.previousIntents ?? [],
    ...(options.residualLockAuthority === undefined
      ? {}
      : { residualLockAuthority: options.residualLockAuthority }),
  };
}

function copyIdentity(value: ReviewSelectionTuple): PluginPayloadIdentity {
  return {
    id: value.id,
    version: value.version,
    payloadSha256: value.payloadSha256,
  };
}

function validateSelection(
  selected: readonly ReviewSelectionTuple[],
): PluginApprovalFailure | PluginPayloadIdentity[] {
  const identities: PluginPayloadIdentity[] = [];
  const exact = new Set<string>();
  const ids = new Set<string>();
  for (const tuple of selected) {
    const identity = copyIdentity(tuple);
    const key = fullIdentityKey(identity);
    if (exact.has(key)) {
      return failure({
        code: "plugin.approval.duplicate-selection",
        message: "Approval selection repeated one exact plugin identity.",
      });
    }
    if (ids.has(identity.id)) {
      return failure({
        code: "plugin.approval.multiple-identities",
        message: "Approval selected more than one identity for one plugin ID.",
      });
    }
    exact.add(key);
    ids.add(identity.id);
    identities.push(identity);
  }
  return identities.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
}

function resolveSelections(
  home: string,
  state: PluginsState,
  selected: readonly PluginPayloadIdentity[],
): PluginApprovalFailure | ResolvedSelection[] {
  const resolved: ResolvedSelection[] = [];
  for (const identity of selected) {
    const record = state.plugins[identity.id];
    const installed = record?.installed.find((candidate) =>
      candidate.version === identity.version &&
      candidate.payloadSha256 === identity.payloadSha256
    );
    const pending = record?.pendingReview.some((candidate) =>
      candidate.version === identity.version &&
      candidate.payloadSha256 === identity.payloadSha256
    ) ?? false;
    if (record === undefined || installed === undefined || !pending) {
      return failure({
        code: "plugin.approval.identity-not-pending",
        message:
          "A selected exact plugin identity is not installed and pending review.",
        details: { identity },
        selected: [...selected],
      });
    }
    resolved.push({
      identity,
      installed,
      artifactPath: resolve(home, installed.relativePath),
    });
  }
  return resolved;
}

function cloneState(state: PluginsState, updatedAt: string): PluginsState {
  const plugins: PluginsState["plugins"] = {};
  for (const id of Object.keys(state.plugins).sort()) {
    const record = state.plugins[id]!;
    plugins[id] = {
      installed: record.installed.map((artifact) => ({
        ...artifact,
        source: { ...artifact.source },
      })),
      enabled: record.enabled === null ? null : { ...record.enabled },
      pendingReview: record.pendingReview.map((identity) => ({ ...identity })),
    };
  }
  return {
    schemaVersion: 1,
    plugins,
    updatedAt,
  };
}

function applyAuthority(
  state: PluginsState,
  selected: readonly PluginPayloadIdentity[],
): void {
  for (const identity of selected) {
    const record = state.plugins[identity.id];
    if (record === undefined) {
      throw new Error("Selected plugin state disappeared before commit.");
    }
    record.enabled = {
      version: identity.version,
      payloadSha256: identity.payloadSha256,
    };
    record.pendingReview = record.pendingReview.filter((candidate) =>
      identityKey(candidate) !== identityKey(identity)
    );
  }
}

function hasCommittedAuthority(
  state: PluginsState,
  selected: readonly PluginPayloadIdentity[],
): boolean {
  return selected.every((identity) => {
    const record = state.plugins[identity.id];
    return record !== undefined &&
      record.enabled?.version === identity.version &&
      record.enabled.payloadSha256 === identity.payloadSha256 &&
      !record.pendingReview.some((candidate) =>
        candidate.version === identity.version &&
        candidate.payloadSha256 === identity.payloadSha256
      );
  });
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Installable text file is not valid UTF-8: ${path}`);
  }
}

function samePaths(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length &&
    actual.every((path, index) => path === expected[index]);
}

function createSnapshot(options: {
  identity: PluginPayloadIdentity;
  manifest: PluginManifestV1;
  files: Map<string, Uint8Array>;
}): PluginPayloadSnapshot {
  const privateFiles = new Map<string, Uint8Array>();
  for (const [path, bytes] of options.files) {
    privateFiles.set(path, new Uint8Array(bytes));
  }
  const paths = Object.freeze([...privateFiles.keys()].sort(compareBytewise));
  const snapshot: PluginPayloadSnapshot = {
    identity: Object.freeze({ ...options.identity }),
    manifest: Object.freeze({
      ...options.manifest,
      assets: Object.freeze([...options.manifest.assets]),
    }) as PluginManifestV1,
    files: paths,
    read(path) {
      const bytes = privateFiles.get(path);
      if (bytes === undefined) {
        throw new Error("Requested payload snapshot file is unavailable.");
      }
      return new Uint8Array(bytes);
    },
  };
  return Object.freeze(snapshot);
}

export async function captureExactPayloadSnapshot(options: {
  artifactPath: string;
  identity: PluginPayloadIdentity;
  signal?: AbortSignal;
  readSnapshotFile(path: string): Promise<Uint8Array>;
}): Promise<
  | { ok: true; snapshot: PluginPayloadSnapshot }
  | { ok: false; message: string; details?: Record<string, unknown> }
> {
  if (options.signal?.aborted) {
    return { ok: false, message: "Payload snapshot was interrupted." };
  }
  let tree;
  try {
    tree = await listPayloadTreeEntries(options.artifactPath);
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Unable to enumerate the installed payload snapshot.",
    };
  }
  const files = tree
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path)
    .sort(compareBytewise);
  const unexpected = files.find((path) => !isInstallableRelativePath(path));
  if (unexpected !== undefined) {
    return {
      ok: false,
      message: `Unexpected non-installable snapshot file: ${unexpected}`,
      details: { path: unexpected },
    };
  }
  const buffers = new Map<string, Uint8Array>();
  try {
    for (const path of files) {
      if (options.signal?.aborted) {
        return { ok: false, message: "Payload snapshot was interrupted." };
      }
      const bytes = await options.readSnapshotFile(
        join(options.artifactPath, ...path.split("/")),
      );
      buffers.set(path, new Uint8Array(bytes));
    }
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Unable to read the installed payload snapshot.",
    };
  }

  const checksumsBytes = buffers.get("checksums.json");
  const manifestBytes = buffers.get("plugin.json");
  const sourceBytes = buffers.get("index.js");
  const mapBytes = buffers.get("index.js.map");
  if (
    checksumsBytes === undefined ||
    manifestBytes === undefined ||
    sourceBytes === undefined ||
    mapBytes === undefined
  ) {
    return {
      ok: false,
      message: "Payload snapshot is missing a required installable file.",
    };
  }

  let checksums: ChecksumsManifest;
  let manifest: PluginManifestV1;
  try {
    checksums = parseChecksumsJson(
      decodeUtf8(checksumsBytes, "checksums.json"),
    );
    const parsed = parsePluginManifest(
      JSON.parse(decodeUtf8(manifestBytes, "plugin.json")) as unknown,
    );
    if (!parsed.ok) throw new Error(parsed.message);
    manifest = parsed.manifest;
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Payload snapshot metadata is invalid.",
    };
  }

  const checksumPaths = Object.keys(checksums.files).sort(compareBytewise);
  const contentPaths = files.filter((path) => path !== "checksums.json");
  if (!samePaths(contentPaths, checksumPaths)) {
    return {
      ok: false,
      message:
        "Payload snapshot files do not exactly match checksums.json records.",
      details: { files: contentPaths, checksums: checksumPaths },
    };
  }
  for (const path of checksumPaths) {
    const bytes = buffers.get(path);
    const expected = checksums.files[path];
    if (
      bytes === undefined ||
      expected === undefined ||
      bytes.byteLength !== expected.bytes ||
      sha256Hex(bytes) !== expected.sha256
    ) {
      return {
        ok: false,
        message: `Payload snapshot checksum mismatch for ${path}.`,
        details: { path },
      };
    }
  }

  const payloadSha256 = computePayloadSha256(checksums);
  if (
    manifest.id !== options.identity.id ||
    manifest.version !== options.identity.version ||
    payloadSha256 !== options.identity.payloadSha256
  ) {
    return {
      ok: false,
      message: "Payload snapshot identity does not match approved authority.",
      details: {
        expected: options.identity,
        actual: {
          id: manifest.id,
          version: manifest.version,
          payloadSha256,
        },
      },
    };
  }
  const assets = contentPaths.filter((path) => path.startsWith("assets/"));
  if (!samePaths(assets, [...manifest.assets].sort(compareBytewise))) {
    return {
      ok: false,
      message:
        "Payload snapshot declared assets do not match checksum-verified bytes.",
    };
  }

  const source = decodeUtf8(sourceBytes, "index.js");
  const browser = scanBrowserSafeIife(source);
  if (!browser.ok) return { ok: false, message: browser.message };
  const sourceMap = validatePluginSourceMapV3({
    mapText: decodeUtf8(mapBytes, "index.js.map"),
    generatedSource: source,
  });
  if (!sourceMap.ok) {
    return {
      ok: false,
      message: sourceMap.message,
      details: sourceMap.details,
    };
  }
  const compatibility = evaluateSdkCompatibility(
    SDK_VERSION,
    manifest.sdkRange,
  );
  if (!compatibility.ok) {
    return {
      ok: false,
      message:
        `Payload snapshot is incompatible with SDK ${SDK_VERSION}: ${compatibility.reason}`,
    };
  }
  const registration = await createInertRegistrationHarness().evaluateSource({
    expectedPluginId: manifest.id,
    source,
  });
  if (!registration.ok) {
    return {
      ok: false,
      message: registration.message,
      details: { registration },
    };
  }

  return {
    ok: true,
    snapshot: createSnapshot({
      identity: options.identity,
      manifest,
      files: buffers,
    }),
  };
}

function mapLockFailure(
  locked: PluginStateLockFailure<PluginApprovalResult>,
  selected: PluginPayloadIdentity[],
): PluginApprovalFailure {
  const completed = locked.completedValue;
  return failure({
    operationId: completed?.operationId ?? "plugin-approval",
    code: locked.code,
    message: locked.message,
    details: locked.details,
    selected: completed?.selected ?? selected,
    stateCommitted: completed?.stateCommitted ?? false,
    snapshots: completed?.snapshots ?? [],
    previousIntents: completed?.previousIntents ?? [],
    residualLockAuthority: locked.residual,
  });
}

export async function approveSelectedPluginArtifacts(options: {
  explodexHome: string;
  selected: readonly ReviewSelectionTuple[];
  now?: () => string;
  signal?: AbortSignal;
  lockWaitMs?: number;
  runtimeAdapters?: RuntimeAdapters;
  operationId?: string;
  adapters?: PluginApprovalAdapters;
}): Promise<PluginApprovalResult> {
  if (options.signal?.aborted) return interrupted();
  const validated = validateSelection(options.selected);
  if (!Array.isArray(validated)) return validated;
  if (validated.length === 0) {
    return {
      ok: true,
      operationId: options.operationId ?? "plugin-approval-empty",
      selected: [],
      stateCommitted: false,
      authorityChanged: false,
      snapshots: [],
      previousIntents: [],
    };
  }

  const home = resolve(options.explodexHome);
  const locked = await withPluginStateLock<PluginApprovalResult>({
    explodexHome: home,
    operation: "plugin.approval",
    signal: options.signal,
    waitBoundMs: options.lockWaitMs,
    runtimeAdapters: options.runtimeAdapters,
    operationId: options.operationId,
    work: async () => {
      const operationId = options.operationId ?? "plugin-approval";
      const loaded = await loadPluginsState({ explodexHome: home });
      if (loaded.status !== "valid") {
        return failure({
          operationId,
          code: "plugin.approval.state-invalid",
          message:
            "Authoritative plugin state is missing or malformed; approval cannot import consent.",
          selected: validated,
        });
      }
      const resolved = resolveSelections(home, loaded.state, validated);
      if (!Array.isArray(resolved)) {
        return { ...resolved, operationId };
      }
      const previousIntents = validated.map((identity) => {
        const enabled = loaded.state.plugins[identity.id]?.enabled ?? null;
        return {
          id: identity.id,
          intent: enabled === null ? null : { ...enabled },
        };
      });

      await options.adapters?.beforeSelectedRevalidation?.();
      if (options.signal?.aborted) {
        return {
          ...interrupted(),
          operationId,
          selected: validated,
          previousIntents,
        };
      }
      for (const artifact of resolved) {
        const standalone = await validateInstallablePayloadDir(
          artifact.artifactPath,
          {
            source: "directory",
            expectedIdentity: artifact.identity,
          },
        );
        if (!standalone.ok) {
          return failure({
            operationId,
            code: "plugin.approval.revalidation-failed",
            message:
              `Selected artifact failed inert standalone revalidation: ${standalone.message}`,
            details: {
              identity: artifact.identity,
              artifactCode: standalone.code,
            },
            selected: validated,
            previousIntents,
          });
        }
      }

      const next = cloneState(
        loaded.state,
        options.now?.() ?? new Date().toISOString(),
      );
      applyAuthority(next, validated);
      try {
        if (options.signal?.aborted) {
          return {
            ...interrupted(),
            operationId,
            selected: validated,
            previousIntents,
          };
        }
        await options.adapters?.beforeStateCommit?.();
        await (options.adapters?.writeState ?? savePluginsStateAtomic)({
          explodexHome: home,
          state: next,
        });
      } catch (error: unknown) {
        const observed = await loadPluginsState({ explodexHome: home });
        const committed = observed.status === "valid" &&
          hasCommittedAuthority(observed.state, validated);
        return failure({
          operationId,
          code: "plugin.approval.state-write-failed",
          message: error instanceof Error
            ? error.message
            : "Approval state commit failed.",
          selected: validated,
          stateCommitted: committed,
          previousIntents,
        });
      }

      await options.adapters?.afterStateCommitBeforeSnapshot?.();
      const snapshots: PluginPayloadSnapshot[] = [];
      const readSnapshotFile = options.adapters?.readSnapshotFile ??
        (async (path: string) => readFile(path));
      for (const artifact of resolved) {
        const captured = await captureExactPayloadSnapshot({
          artifactPath: artifact.artifactPath,
          identity: artifact.identity,
          signal: options.signal,
          readSnapshotFile,
        });
        if (!captured.ok) {
          return failure({
            operationId,
            code: options.signal?.aborted
              ? "operation.interrupted"
              : "plugin.approval.snapshot-invalid",
            message: captured.message,
            details: {
              identity: artifact.identity,
              ...captured.details,
            },
            selected: validated,
            stateCommitted: true,
            snapshots: [],
            previousIntents,
          });
        }
        snapshots.push(captured.snapshot);
      }
      if (options.signal?.aborted) {
        return failure({
          operationId,
          code: "operation.interrupted",
          message:
            "Plugin approval was interrupted after authority committed and before source delivery.",
          selected: validated,
          stateCommitted: true,
          snapshots: [],
          previousIntents,
        });
      }
      await options.adapters?.afterSnapshot?.();
      if (options.signal?.aborted) {
        return failure({
          operationId,
          code: "operation.interrupted",
          message:
            "Plugin approval was interrupted after authority committed and before source delivery.",
          selected: validated,
          stateCommitted: true,
          snapshots: [],
          previousIntents,
        });
      }
      return {
        ok: true,
        operationId,
        selected: validated,
        stateCommitted: true,
        authorityChanged: true,
        snapshots,
        previousIntents,
      };
    },
  });
  return locked.ok ? locked.value : mapLockFailure(locked, validated);
}
