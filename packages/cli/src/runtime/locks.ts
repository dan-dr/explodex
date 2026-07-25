/**
 * Command-lifetime operation locks backed by a parent-held Darwin advisory lease.
 * The private container and stable lease inode persist; only the open descriptor
 * grants active authority.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AdvisoryLease, LockPathStat, RuntimeAdapters } from "./adapters.ts";
import {
  DEFAULT_STAGE_BOUNDS_MS,
  type LockResource,
  type OperationIdentity,
  type OperationLockRecord,
} from "./types.ts";

const LOCK_SCHEMA_VERSION = 2 as const;
const LOCK_PROTOCOL = "darwin-flock-v1" as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CONTAINER_MARKER_NAME = "container.json";
const LEASE_NAME = "lease";
const OWNER_RECORD_NAME = "owner.json";
const LOCK_STAGE = "lock-acquisition" as const;
/**
 * The dead-owner identity probe must not inherit the remaining acquisition
 * budget, which can be a single millisecond under a nonblocking attempt.
 */
const IDENTITY_PROBE_BOUND_MS = 1_000;

export type LockAcquireFailureCode =
  | "lock_busy"
  | "lock_interrupted"
  | "lock_stale_unrecoverable"
  | "lock_invariant_violation"
  | "invalid_stage_bound";

export type LockAcquireResult =
  | {
      ok: true;
      record: OperationLockRecord;
      path: string;
      leasePath: string;
      descriptor: number;
      closeOnExec: true;
      recoveredStale: boolean;
      handle: LockHandle;
    }
  | {
      ok: false;
      code: LockAcquireFailureCode;
      message: string;
      holder: OperationLockRecord | null;
      path: string;
      leasePath: string;
      stage: typeof LOCK_STAGE;
      boundMs: number;
    };

export type LockHandleState = {
  descriptorOpen: boolean;
  leaseHeld: boolean;
  releasedMetadataWritten: boolean;
};

export type LockHandle = {
  readonly path: string;
  readonly leasePath: string;
  readonly record: OperationLockRecord;
  readonly descriptor: number;
  readonly closeOnExec: true;
  state(): LockHandleState;
  release(options?: { abortSignal?: AbortSignal; timeoutMs?: number }): Promise<void>;
};

type LockContainerRecord = {
  schemaVersion: 1;
  protocol: typeof LOCK_PROTOCOL;
  resource: LockResource;
  containerId: string;
};

type ContainerState = {
  path: string;
  leasePath: string;
  ownerPath: string;
  container: LockContainerRecord;
  leaseStat: LockPathStat;
};

export type AcquireLockOptions = {
  adapters: RuntimeAdapters;
  explodexHome: string;
  resource: LockResource;
  identity: OperationIdentity;
  /** 0 means one nonblocking attempt. Positive values enable bounded polling. */
  waitBoundMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
};

/** Declared finite bound for the `lock-acquisition` stage. */
export const LOCK_ACQUISITION_BOUND_MS = DEFAULT_STAGE_BOUNDS_MS[LOCK_STAGE];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLockResource(value: unknown): value is LockResource {
  return value === "plugins-state" || value === "main-launch" ||
    value === "dev-instance" || value === "registry-publication";
}

function isDecimalIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function newOpaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sameLeaseIdentity(
  left: Pick<LockPathStat, "device" | "inode">,
  right: Pick<LockPathStat, "device" | "inode">,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameLockOwner(a: OperationLockRecord, b: OperationLockRecord): boolean {
  return a.schemaVersion === b.schemaVersion && a.protocol === b.protocol &&
    a.resource === b.resource && a.containerId === b.containerId &&
    a.generation === b.generation && a.operationId === b.operationId &&
    a.pid === b.pid && a.processStartedAt === b.processStartedAt &&
    a.acquiredAt === b.acquiredAt && a.leaseDevice === b.leaseDevice &&
    a.leaseInode === b.leaseInode;
}

function parseContainerRecord(value: unknown): LockContainerRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.protocol !== LOCK_PROTOCOL) {
    return null;
  }
  if (!isLockResource(value.resource) || !isNonEmptyString(value.containerId)) return null;
  return {
    schemaVersion: 1,
    protocol: LOCK_PROTOCOL,
    resource: value.resource,
    containerId: value.containerId,
  };
}

export function parseOperationLockRecord(value: unknown): OperationLockRecord | null {
  if (!isRecord(value) || value.schemaVersion !== LOCK_SCHEMA_VERSION ||
    value.protocol !== LOCK_PROTOCOL) return null;
  if (!isLockResource(value.resource) || !isNonEmptyString(value.containerId) ||
    (value.state !== "held" && value.state !== "released") ||
    !isNonEmptyString(value.generation) || !isNonEmptyString(value.operationId) ||
    typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 ||
    !isNonEmptyString(value.processStartedAt) || !isNonEmptyString(value.acquiredAt) ||
    !isDecimalIdentity(value.leaseDevice) || !isDecimalIdentity(value.leaseInode)) {
    return null;
  }
  if (value.state === "held" && value.releasedAt !== null) return null;
  if (value.state === "released" && !isNonEmptyString(value.releasedAt)) return null;
  const releasedAt = value.state === "released" ? value.releasedAt as string : null;
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    protocol: LOCK_PROTOCOL,
    resource: value.resource,
    containerId: value.containerId,
    state: value.state,
    generation: value.generation,
    operationId: value.operationId,
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    acquiredAt: value.acquiredAt,
    releasedAt,
    leaseDevice: value.leaseDevice,
    leaseInode: value.leaseInode,
  };
}

export function locksDirectory(explodexHome: string): string {
  return join(explodexHome, "locks");
}

export function lockPath(explodexHome: string, resource: LockResource): string {
  return join(locksDirectory(explodexHome), `${resource}.lock`);
}

export function leasePath(explodexHome: string, resource: LockResource): string {
  return join(lockPath(explodexHome, resource), LEASE_NAME);
}

function ownerRecordPath(containerPath: string): string {
  return join(containerPath, OWNER_RECORD_NAME);
}

function containerRecordPath(containerPath: string): string {
  return join(containerPath, CONTAINER_MARKER_NAME);
}

function validatePrivatePath(
  stat: LockPathStat,
  expectedKind: "directory" | "regular-file",
  expectedMode: number,
  expectedUid: number,
  label: string,
): void {
  if (stat.kind !== expectedKind) {
    throw new Error(`${label} must be a non-symlink ${expectedKind}`);
  }
  if (stat.mode !== expectedMode) {
    throw new Error(`${label} must have mode ${expectedMode.toString(8)}`);
  }
  if (expectedUid >= 0 && stat.uid !== expectedUid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  // Real directories carry one link per entry plus their own; only the stable
  // lease and metadata files must be single-link to exclude hard-link aliases.
  if (expectedKind === "regular-file" && stat.linkCount !== 1) {
    throw new Error(`${label} must have exactly one filesystem link`);
  }
}

async function readJson(adapters: RuntimeAdapters, path: string): Promise<unknown> {
  return JSON.parse(await adapters.fs.readText(path)) as unknown;
}

async function initializeContainer(
  adapters: RuntimeAdapters,
  directory: string,
  path: string,
  resource: LockResource,
): Promise<void> {
  await adapters.fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryStat = await adapters.fs.statPath(directory);
  validatePrivatePath(
    directoryStat,
    "directory",
    PRIVATE_DIRECTORY_MODE,
    adapters.fs.currentUid(),
    "Lock root",
  );

  const existing = await adapters.fs.statPath(path);
  if (existing.kind !== "missing") return;

  const stagingPath = join(
    directory,
    `.explodex-lock-init-${resource}-${newOpaqueId("container")}`,
  );
  const created = await adapters.fs.createDirectoryExclusive(stagingPath, PRIVATE_DIRECTORY_MODE);
  if (!created) throw new Error(`Lock ${resource} staging directory already exists`);

  let published = false;
  try {
    const leaseCreated = await adapters.fs.writeFileExclusive(
      join(stagingPath, LEASE_NAME),
      "",
      PRIVATE_FILE_MODE,
    );
    if (!leaseCreated) throw new Error(`Lock ${resource} staging lease already exists`);
    const container: LockContainerRecord = {
      schemaVersion: 1,
      protocol: LOCK_PROTOCOL,
      resource,
      containerId: newOpaqueId("container"),
    };
    const markerCreated = await adapters.fs.writeFileExclusive(
      containerRecordPath(stagingPath),
      serialized(container),
      PRIVATE_FILE_MODE,
    );
    if (!markerCreated) throw new Error(`Lock ${resource} staging marker already exists`);

    // One rename publishes a complete container. Losing the race is normal
    // concurrency; the winner's canonical container and lease inode stay intact.
    published = await adapters.fs.publishDirectoryExclusive(stagingPath, path) === "published";
  } finally {
    if (!published) await adapters.fs.removePrivateDirectory(stagingPath);
  }
}

async function inspectContainer(
  adapters: RuntimeAdapters,
  path: string,
  resource: LockResource,
): Promise<ContainerState> {
  const currentUid = adapters.fs.currentUid();
  const containerStat = await adapters.fs.statPath(path);
  validatePrivatePath(
    containerStat,
    "directory",
    PRIVATE_DIRECTORY_MODE,
    currentUid,
    `Lock ${resource} container`,
  );

  const markerPath = containerRecordPath(path);
  validatePrivatePath(
    await adapters.fs.statPath(markerPath),
    "regular-file",
    PRIVATE_FILE_MODE,
    currentUid,
    `Lock ${resource} container marker`,
  );
  const container = parseContainerRecord(await readJson(adapters, markerPath));
  if (container === null || container.resource !== resource) {
    throw new Error(`Lock ${resource} has malformed or mismatched container metadata`);
  }

  const stableLeasePath = join(path, LEASE_NAME);
  const leaseStat = await adapters.fs.statPath(stableLeasePath);
  validatePrivatePath(
    leaseStat,
    "regular-file",
    PRIVATE_FILE_MODE,
    currentUid,
    `Lock ${resource} lease`,
  );

  const ownerPath = ownerRecordPath(path);
  const ownerStat = await adapters.fs.statPath(ownerPath);
  if (ownerStat.kind !== "missing") {
    validatePrivatePath(
      ownerStat,
      "regular-file",
      PRIVATE_FILE_MODE,
      currentUid,
      `Lock ${resource} owner metadata`,
    );
  }
  return { path, leasePath: stableLeasePath, ownerPath, container, leaseStat };
}

async function readOwnerRecord(
  adapters: RuntimeAdapters,
  state: ContainerState,
): Promise<OperationLockRecord | null> {
  const stat = await adapters.fs.statPath(state.ownerPath);
  if (stat.kind === "missing") return null;
  validatePrivatePath(
    stat,
    "regular-file",
    PRIVATE_FILE_MODE,
    adapters.fs.currentUid(),
    `Lock ${state.container.resource} owner metadata`,
  );
  let parsed: OperationLockRecord | null = null;
  try {
    parsed = parseOperationLockRecord(await readJson(adapters, state.ownerPath));
  } catch {
    parsed = null;
  }
  if (parsed === null || parsed.resource !== state.container.resource ||
    parsed.containerId !== state.container.containerId ||
    parsed.leaseDevice !== state.leaseStat.device ||
    parsed.leaseInode !== state.leaseStat.inode) {
    throw new Error(`Lock ${state.container.resource} has malformed or inconsistent owner metadata`);
  }
  return parsed;
}

function failure(
  code: LockAcquireFailureCode,
  message: string,
  holder: OperationLockRecord | null,
  path: string,
  stableLeasePath: string,
  boundMs: number,
): LockAcquireResult {
  return {
    ok: false,
    code,
    message,
    holder,
    path,
    leasePath: stableLeasePath,
    stage: LOCK_STAGE,
    boundMs,
  };
}

function systemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function failClosedMessage(error: unknown, resource: LockResource): string {
  return error instanceof Error ? error.message : `Lock ${resource} validation failed`;
}

async function closeAfterFailure(lease: AdvisoryLease, error: unknown): Promise<never> {
  try {
    await lease.close();
  } catch (closeError: unknown) {
    const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(`${original}; advisory lease descriptor close failed: ${closeMessage}`);
  }
  throw error;
}

function createHandle(
  adapters: RuntimeAdapters,
  state: ContainerState,
  record: OperationLockRecord,
  lease: AdvisoryLease,
): LockHandle {
  let descriptorOpen = true;
  let leaseHeld = true;
  let releasedMetadataWritten = false;
  let releasePromise: Promise<void> | null = null;

  const performRelease = async (
    options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> => {
    const timeoutMs = options.timeoutMs;
    const deadline = timeoutMs === undefined ? null : adapters.clock.nowMs() + timeoutMs;
    const requireBudget = (): void => {
      if (deadline !== null && adapters.clock.nowMs() > deadline) {
        throw new Error(
          `Lock ${record.resource} release metadata exceeded the declared ${String(timeoutMs)}ms bound`,
        );
      }
    };
    let releaseError: unknown = null;
    try {
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw Object.assign(
          new Error(`Lock ${record.resource} release bound must be finite and positive`),
          { code: "invalid_stage_bound" },
        );
      }
      const descriptorStat = await lease.stat();
      const pathStat = await adapters.fs.statPath(state.leasePath);
      validatePrivatePath(
        pathStat,
        "regular-file",
        PRIVATE_FILE_MODE,
        adapters.fs.currentUid(),
        `Lock ${record.resource} lease during release`,
      );
      if (!sameLeaseIdentity(descriptorStat, pathStat) ||
        descriptorStat.device !== record.leaseDevice ||
        descriptorStat.inode !== record.leaseInode) {
        throw new Error(`Lock ${record.resource} lease path was substituted before release`);
      }
      requireBudget();
      const current = await readOwnerRecord(adapters, state);
      if (current === null || current.state !== "held" || !sameLockOwner(current, record)) {
        throw new Error(`Lock ${record.resource} owner generation changed before release`);
      }
      requireBudget();
      if (options.abortSignal?.aborted) {
        throw Object.assign(new Error(`Lock ${record.resource} release metadata was interrupted`), {
          code: "ABORT_ERR",
        });
      }
      const released: OperationLockRecord = {
        ...record,
        state: "released",
        releasedAt: adapters.clock.nowIso(),
      };
      await adapters.fs.writeTextAtomic(state.ownerPath, serialized(released), PRIVATE_FILE_MODE);
      releasedMetadataWritten = true;
    } catch (error: unknown) {
      releaseError = error;
    } finally {
      try {
        await lease.close();
        descriptorOpen = false;
        leaseHeld = false;
      } catch (closeError: unknown) {
        if (releaseError === null) releaseError = closeError;
        else {
          const first = releaseError instanceof Error ? releaseError.message : String(releaseError);
          const second = closeError instanceof Error ? closeError.message : String(closeError);
          releaseError = new Error(`${first}; advisory lease descriptor close failed: ${second}`);
        }
      }
    }
    if (releaseError !== null) throw releaseError;
  };

  return {
    path: state.path,
    leasePath: state.leasePath,
    record,
    descriptor: lease.descriptor,
    closeOnExec: lease.closeOnExec,
    state() {
      return { descriptorOpen, leaseHeld, releasedMetadataWritten };
    },
    release(options) {
      if (releasePromise === null) releasePromise = performRelease(options);
      return releasePromise;
    },
  };
}

export async function acquireOperationLock(options: AcquireLockOptions): Promise<LockAcquireResult> {
  const { adapters, explodexHome, resource, identity } = options;
  const waitBoundMs = options.waitBoundMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const path = lockPath(explodexHome, resource);
  const stableLeasePath = join(path, LEASE_NAME);

  if (!Number.isFinite(waitBoundMs) || waitBoundMs < 0 ||
    !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return failure(
      "invalid_stage_bound",
      "Lock wait bound must be finite and non-negative, and poll interval finite and positive",
      null,
      path,
      stableLeasePath,
      Number.isFinite(waitBoundMs) ? waitBoundMs : 0,
    );
  }

  let state: ContainerState;
  try {
    await initializeContainer(adapters, locksDirectory(explodexHome), path, resource);
    state = await inspectContainer(adapters, path, resource);
  } catch (error: unknown) {
    return failure(
      "lock_stale_unrecoverable",
      failClosedMessage(error, resource),
      null,
      path,
      stableLeasePath,
      waitBoundMs,
    );
  }

  const startedAt = adapters.clock.nowMs();
  const deadline = startedAt + waitBoundMs;
  let firstAttempt = true;
  let lastHolder: OperationLockRecord | null = null;

  for (;;) {
    if (options.abortSignal?.aborted) {
      return failure(
        "lock_interrupted",
        `Lock ${resource} acquisition was interrupted`,
        lastHolder,
        path,
        state.leasePath,
        waitBoundMs,
      );
    }
    let opened;
    try {
      opened = await adapters.fs.tryAcquireLease(state.leasePath);
    } catch (error: unknown) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ELOOP" || code === "EINVAL" || code === "ENOTSUP") {
        return failure(
          "lock_stale_unrecoverable",
          `Lock ${resource} stable lease could not be opened: ${failClosedMessage(error, resource)}`,
          lastHolder,
          path,
          state.leasePath,
          waitBoundMs,
        );
      }
      throw error;
    }
    if (opened.status === "acquired") {
      const lease = opened.lease;
      try {
        if (options.abortSignal?.aborted) {
          await lease.close();
          return failure(
            "lock_interrupted",
            `Lock ${resource} acquisition was interrupted`,
            lastHolder,
            path,
            state.leasePath,
            waitBoundMs,
          );
        }
        if (!firstAttempt && adapters.clock.nowMs() > deadline) {
          await lease.close();
          return failure(
            "lock_busy",
            `Lock ${resource} acquisition ended after the declared bound`,
            lastHolder,
            path,
            state.leasePath,
            waitBoundMs,
          );
        }

        let descriptorStat: LockPathStat;
        let prior: OperationLockRecord | null;
        try {
          descriptorStat = await lease.stat();
          state = await inspectContainer(adapters, path, resource);
          if (!sameLeaseIdentity(descriptorStat, state.leaseStat)) {
            throw new Error(`Lock ${resource} lease path changed during acquisition`);
          }
          prior = await readOwnerRecord(adapters, state);
        } catch (error: unknown) {
          if (systemErrorCode(error) !== null) throw error;
          await lease.close();
          return failure(
            "lock_stale_unrecoverable",
            failClosedMessage(error, resource),
            null,
            path,
            state.leasePath,
            waitBoundMs,
          );
        }

        let recoveredStale = false;
        if (prior?.state === "held") {
          const live = await adapters.process.isAlive(
            prior.pid,
            prior.processStartedAt,
            { abortSignal: options.abortSignal, timeoutMs: IDENTITY_PROBE_BOUND_MS },
          );
          if (live) {
            await lease.close();
            return failure(
              "lock_invariant_violation",
              `Lock ${resource} kernel lease was free while recorded owner remained live`,
              prior,
              path,
              state.leasePath,
              waitBoundMs,
            );
          }
          recoveredStale = true;
        }

        const record: OperationLockRecord = {
          schemaVersion: LOCK_SCHEMA_VERSION,
          protocol: LOCK_PROTOCOL,
          resource,
          containerId: state.container.containerId,
          state: "held",
          generation: newOpaqueId("generation"),
          operationId: identity.operationId,
          pid: identity.ownerPid,
          processStartedAt: identity.ownerProcessStartedAt,
          acquiredAt: adapters.clock.nowIso(),
          releasedAt: null,
          leaseDevice: descriptorStat.device,
          leaseInode: descriptorStat.inode,
        };
        if (options.abortSignal?.aborted) {
          await lease.close();
          return failure(
            "lock_interrupted",
            `Lock ${resource} acquisition was interrupted before owner publication`,
            prior,
            path,
            state.leasePath,
            waitBoundMs,
          );
        }
        await adapters.fs.writeTextAtomic(state.ownerPath, serialized(record), PRIVATE_FILE_MODE);
        const handle = createHandle(adapters, state, record, lease);
        return {
          ok: true,
          record,
          path,
          leasePath: state.leasePath,
          descriptor: lease.descriptor,
          closeOnExec: lease.closeOnExec,
          recoveredStale,
          handle,
        };
      } catch (error: unknown) {
        return closeAfterFailure(lease, error);
      }
    }

    try {
      lastHolder = await readOwnerRecord(adapters, state);
    } catch {
      lastHolder = null;
    }
    if (waitBoundMs === 0 || adapters.clock.nowMs() >= deadline) {
      return failure(
        "lock_busy",
        waitBoundMs === 0
          ? `Lock ${resource} is held by another operation`
          : `Lock ${resource} remained busy for ${waitBoundMs}ms`,
        lastHolder,
        path,
        state.leasePath,
        waitBoundMs,
      );
    }
    firstAttempt = false;
    const sleepBudget = deadline - adapters.clock.nowMs();
    const slept = await sleep(
      adapters,
      Math.min(pollIntervalMs, sleepBudget),
      options.abortSignal,
    );
    if (slept === "interrupted") {
      return failure(
        "lock_interrupted",
        `Lock ${resource} acquisition was interrupted`,
        lastHolder,
        path,
        state.leasePath,
        waitBoundMs,
      );
    }
  }
}

export async function releaseOperationLock(
  _adapters: RuntimeAdapters,
  handle: LockHandle,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  await handle.release(options);
}

export type WithOperationLockResult<T> =
  | { ok: true; record: OperationLockRecord; recoveredStale: boolean; value: T }
  | (Extract<LockAcquireResult, { ok: false }> & { value?: undefined });

/**
 * Acquire the lease, run `work` while it is held, then release it on every path.
 * A release failure surfaces even when the work itself succeeded.
 */
export async function withOperationLock<T>(
  options: AcquireLockOptions,
  work: (handle: LockHandle) => Promise<T> | T,
): Promise<WithOperationLockResult<T>> {
  const acquired = await acquireOperationLock(options);
  if (!acquired.ok) return acquired;
  const releaseOptions = { abortSignal: options.abortSignal };
  let value: T;
  try {
    value = await work(acquired.handle);
  } catch (error: unknown) {
    await acquired.handle.release(releaseOptions).catch(() => undefined);
    throw error;
  }
  await acquired.handle.release(releaseOptions);
  return {
    ok: true,
    record: acquired.record,
    recoveredStale: acquired.recoveredStale,
    value,
  };
}

function sleep(
  adapters: RuntimeAdapters,
  ms: number,
  abortSignal?: AbortSignal,
): Promise<"elapsed" | "interrupted"> {
  return new Promise((resolve) => {
    const handle = adapters.timers.setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    const onAbort = (): void => {
      handle.clear();
      resolve("interrupted");
    };
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
