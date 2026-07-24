/**
 * Command-lifetime operation locks. Never a service or process-adoption authority.
 */

import { join } from "node:path";
import type { RuntimeAdapters } from "./adapters.ts";
import type { LockResource, OperationIdentity, OperationLockRecord } from "./types.ts";

export type LockAcquireResult =
  | { ok: true; record: OperationLockRecord; path: string; recoveredStale: boolean }
  | {
      ok: false;
      code: "lock_busy" | "lock_stale_unrecoverable" | "invalid_stage_bound";
      message: string;
      holder: OperationLockRecord | null;
      path: string;
    };

export type LockHandle = {
  readonly path: string;
  readonly record: OperationLockRecord;
  release(options?: { abortSignal?: AbortSignal; timeoutMs?: number }): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseOperationLockRecord(value: unknown): OperationLockRecord | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (
    value.resource !== "plugins-state" &&
    value.resource !== "main-launch" &&
    value.resource !== "dev-instance" &&
    value.resource !== "registry-publication"
  ) {
    return null;
  }
  if (!isNonEmptyString(value.operationId)) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (!isNonEmptyString(value.processStartedAt)) return null;
  if (!isNonEmptyString(value.acquiredAt)) return null;
  return {
    schemaVersion: 1,
    resource: value.resource,
    operationId: value.operationId,
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    acquiredAt: value.acquiredAt,
  };
}

export function locksDirectory(explodexHome: string): string {
  return join(explodexHome, "locks");
}

export function lockPath(explodexHome: string, resource: LockResource): string {
  return join(locksDirectory(explodexHome), `${resource}.lock`);
}

function lockDirectoryPath(explodexHome: string, resource: LockResource): string {
  return lockPath(explodexHome, resource);
}

function lockRecordPath(lockDirectory: string): string {
  return join(lockDirectory, "owner.json");
}

export type AcquireLockOptions = {
  adapters: RuntimeAdapters;
  explodexHome: string;
  resource: LockResource;
  identity: OperationIdentity;
  /**
   * Maximum time to wait for a live holder to release (ms).
   * 0 = try once, no wait. Default uses stage bound for lock-acquisition when provided.
   */
  waitBoundMs?: number;
  /** Poll interval while waiting (ms). */
  pollIntervalMs?: number;
  /** Cooperative cancellation for a bounded lock-acquisition stage. */
  abortSignal?: AbortSignal;
};

/**
 * Acquire a private command-lifetime lock via atomic exclusive create.
 * Stale locks (owner dead or start-identity mismatched) are replaced.
 * A stale lock never authorizes process adoption — only lock file replacement.
 */
export async function acquireOperationLock(options: AcquireLockOptions): Promise<LockAcquireResult> {
  const { adapters, explodexHome, resource, identity } = options;
  const waitBoundMs = options.waitBoundMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const path = lockDirectoryPath(explodexHome, resource);
  const recordPath = lockRecordPath(path);
  const dir = locksDirectory(explodexHome);

  if (!Number.isFinite(waitBoundMs) || waitBoundMs < 0) {
    return {
      ok: false,
      code: "invalid_stage_bound",
      message: "Lock wait bound must be finite and non-negative",
      holder: null,
      path,
    };
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return {
      ok: false,
      code: "invalid_stage_bound",
      message: "Lock poll interval must be finite and positive",
      holder: null,
      path,
    };
  }

  await adapters.fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const deadline = adapters.clock.nowMs() + waitBoundMs;
  const abortSignal = options.abortSignal;
  let recoveredStale = false;
  let initialAttempt = true;

  const isAborted = (): boolean => abortSignal?.aborted === true;
  const canPublish = (): boolean =>
    !isAborted() && (initialAttempt || adapters.clock.nowMs() <= deadline);

  for (;;) {
    const record: OperationLockRecord = {
      schemaVersion: 1,
      resource,
      operationId: identity.operationId,
      pid: identity.ownerPid,
      processStartedAt: identity.ownerProcessStartedAt,
      acquiredAt: adapters.clock.nowIso(),
    };
    const body = `${JSON.stringify(record, null, 2)}\n`;
    const stagingPath = join(
      dir,
      `.explodex-lock-acquire-${resource}-${identity.operationId}-${identity.ownerPid}`,
    );
    try {
      const staged = await adapters.fs.createDirectoryExclusive(stagingPath, 0o700);
      if (!staged) {
        return {
          ok: false,
          code: "lock_stale_unrecoverable",
          message: `Lock ${resource} staging path already exists`,
          holder: null,
          path,
        };
      }
      const ownerWritten = await adapters.fs.writeFileExclusive(
        lockRecordPath(stagingPath),
        body,
        0o600,
      );
      if (!ownerWritten) {
        throw new Error(`Lock ${resource} owner record already exists in private staging`);
      }
      if (!canPublish()) {
        await adapters.fs.removeFile(lockRecordPath(stagingPath));
        await adapters.fs.removeDirectory(stagingPath);
        return {
          ok: false,
          code: "lock_busy",
          message: `Lock ${resource} acquisition ended before publication`,
          holder: null,
          path,
        };
      }
      const publicationBudget = initialAttempt && waitBoundMs === 0
        ? 1_000
        : deadline - adapters.clock.nowMs();
      if (publicationBudget < 0 || isAborted()) {
        await adapters.fs.removeFile(lockRecordPath(stagingPath));
        await adapters.fs.removeDirectory(stagingPath);
        return {
          ok: false,
          code: "lock_busy",
          message: `Lock ${resource} acquisition ended before publication`,
          holder: null,
          path,
        };
      }
      let installed: boolean;
      try {
        installed = await adapters.fs.renameExclusive(stagingPath, path, {
          abortSignal,
          timeoutMs: Math.max(1, publicationBudget),
        });
      } catch (error: unknown) {
        let publishedText: string | null = null;
        try {
          publishedText = await adapters.fs.readText(recordPath);
        } catch {
          publishedText = null;
        }
        if (publishedText === body) {
          await adapters.fs.compareAndRemoveDirectory(
            path,
            "owner.json",
            body,
            { timeoutMs: 1_000 },
          );
        }
        throw error;
      }
      if (installed) return { ok: true, record, path, recoveredStale };
      initialAttempt = false;
      await adapters.fs.removeFile(lockRecordPath(stagingPath));
      await adapters.fs.removeDirectory(stagingPath);
    } catch (error: unknown) {
      try {
        await adapters.fs.removeFile(lockRecordPath(stagingPath));
        await adapters.fs.removeDirectory(stagingPath);
      } catch {
        // Preserve the original publication failure.
      }
      throw error;
    }

    if (!await adapters.fs.isDirectory(path) && !await adapters.fs.isFile(path)) {
      return {
        ok: false,
        code: "lock_stale_unrecoverable",
        message: `Lock ${resource} is neither a regular legacy owner nor a hardened directory`,
        holder: null,
        path,
      };
    }

    // Contended: a legacy regular-file owner shares this exact canonical path.
    // We never unlink it automatically because an old client could replace it
    // between inspection and removal. Mixed-version safety is fail-closed.
    if (await adapters.fs.isFile(path)) {
      let legacyHolder: OperationLockRecord | null = null;
      try {
        legacyHolder = parseOperationLockRecord(
          JSON.parse(await adapters.fs.readText(path)) as unknown,
        );
      } catch {
        legacyHolder = null;
      }
      return {
        ok: false,
        code: "lock_stale_unrecoverable",
        message: `Lock ${resource} is held by a legacy file owner and requires explicit quiescent recovery`,
        holder: legacyHolder,
        path,
      };
    }

    // Contended hardened directory: inspect holder. Malformed records fail closed.
    let holder: OperationLockRecord | null = null;
    let holderText: string | null = null;
    try {
      holderText = await adapters.fs.readText(recordPath);
      holder = parseOperationLockRecord(JSON.parse(holderText) as unknown);
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === "ENOENT" && !(await adapters.fs.exists(path))) {
        if (adapters.clock.nowMs() <= deadline && !isAborted()) continue;
        return {
          ok: false,
          code: "lock_busy",
          message: `Lock ${resource} changed while acquisition ended`,
          holder: null,
          path,
        };
      }
      holder = null;
    }

    if (holder === null || holderText === null) {
      return {
        ok: false,
        code: "lock_stale_unrecoverable",
        message: `Lock ${resource} has an unreadable or malformed owner record`,
        holder: null,
        path,
      };
    }

    const identityBudget = deadline - adapters.clock.nowMs();
    if (identityBudget < 0 || isAborted()) {
      return {
        ok: false,
        code: "lock_busy",
        message: `Lock ${resource} ownership check exceeded its bound`,
        holder,
        path,
      };
    }
    const alive = await adapters.process.isAlive(
      holder.pid,
      holder.processStartedAt,
      { abortSignal, timeoutMs: Math.max(1, identityBudget) },
    );
    if (!alive) {
      const removalBudget = deadline - adapters.clock.nowMs();
      if (removalBudget < 0 || isAborted()) {
        return {
          ok: false,
          code: "lock_busy",
          message: `Lock ${resource} stale recovery exceeded its bound`,
          holder,
          path,
        };
      }
      const removed = await adapters.fs.compareAndRemoveDirectory(
        path,
        "owner.json",
        holderText,
        { abortSignal, timeoutMs: Math.max(1, removalBudget) },
      );
      if (removed) {
        recoveredStale = true;
        continue;
      }
      // Ownership changed between inspection and removal. Retry from a fresh read.
      if (adapters.clock.nowMs() >= deadline) {
        let replacement: OperationLockRecord | null = null;
        try {
          replacement = parseOperationLockRecord(
            JSON.parse(await adapters.fs.readText(recordPath)) as unknown,
          );
        } catch {
          replacement = null;
        }
        return {
          ok: false,
          code: replacement === null ? "lock_stale_unrecoverable" : "lock_busy",
          message:
            replacement === null
              ? `Lock ${resource} changed to an unreadable owner record`
              : `Lock ${resource} was replaced by another operation`,
          holder: replacement,
          path,
        };
      }
      continue;
    }

    if (adapters.clock.nowMs() >= deadline) {
      return {
        ok: false,
        code: "lock_busy",
        message: `Lock ${resource} is held by another live operation`,
        holder,
        path,
      };
    }

    const sleepBudget = deadline - adapters.clock.nowMs();
    if (sleepBudget <= 0 || isAborted()) {
      return {
        ok: false,
        code: "lock_busy",
        message: `Lock ${resource} is held by another live operation`,
        holder,
        path,
      };
    }
    await sleep(adapters, Math.min(pollIntervalMs, sleepBudget), abortSignal);
  }
}

export async function releaseOperationLock(
  adapters: RuntimeAdapters,
  path: string,
  expectedRecord: OperationLockRecord,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (await adapters.fs.isFile(path)) {
    throw new Error("Refused to release a legacy regular-file lock through a directory lock handle");
  }
  if (!await adapters.fs.isDirectory(path)) {
    if (!await adapters.fs.exists(path)) return;
    throw new Error("Refused to release a non-directory lock path");
  }
  const recordPath = lockRecordPath(path);
  let text: string;
  try {
    text = await adapters.fs.readText(recordPath);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT" && !(await adapters.fs.exists(path))) return;
    throw error;
  }
  let holder: OperationLockRecord | null = null;
  try {
    holder = parseOperationLockRecord(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    throw error instanceof Error
      ? error
      : new Error("Lock owner record could not be parsed during release");
  }
  if (holder === null) {
    throw new Error("Lock owner record is malformed during release");
  }
  if (!sameLockOwner(holder, expectedRecord)) return;
  if (options.abortSignal?.aborted) {
    throw Object.assign(new Error("Lock release aborted before ownership removal"), {
      code: "ABORT_ERR",
    });
  }
  const removed = await adapters.fs.compareAndRemoveDirectory(
    path,
    "owner.json",
    text,
    options,
  );
  if (!removed && await adapters.fs.exists(path)) {
    throw new Error("Lock release could not atomically remove the owned record");
  }
}

/** Convenience: acquire and return a handle with release(). */
export async function withOperationLock(
  options: AcquireLockOptions,
): Promise<LockAcquireResult & { handle?: LockHandle }> {
  const result = await acquireOperationLock(options);
  if (!result.ok) return result;
  const handle: LockHandle = {
    path: result.path,
    record: result.record,
    async release(releaseOptions) {
      await releaseOperationLock(options.adapters, result.path, result.record, releaseOptions);
    },
  };
  return { ...result, handle };
}

function sameLockOwner(a: OperationLockRecord, b: OperationLockRecord): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.resource === b.resource &&
    a.operationId === b.operationId &&
    a.pid === b.pid &&
    a.processStartedAt === b.processStartedAt &&
    a.acquiredAt === b.acquiredAt
  );
}

function sleep(
  adapters: RuntimeAdapters,
  ms: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = adapters.timers.setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      handle.clear();
      reject(Object.assign(new Error("Lock acquisition interrupted"), { code: "ABORT_ERR" }));
    };
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
