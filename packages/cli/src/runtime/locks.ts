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
      code: "lock_busy";
      message: string;
      holder: OperationLockRecord | null;
      path: string;
    };

export type LockHandle = {
  readonly path: string;
  readonly record: OperationLockRecord;
  release(): Promise<void>;
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
  const path = lockPath(explodexHome, resource);
  const dir = locksDirectory(explodexHome);

  await adapters.fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const deadline = adapters.clock.nowMs() + waitBoundMs;
  let recoveredStale = false;

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
    const created = await adapters.fs.writeFileExclusive(path, body, 0o600);
    if (created) {
      return { ok: true, record, path, recoveredStale };
    }

    // Contended: inspect holder.
    let holder: OperationLockRecord | null = null;
    try {
      const text = await adapters.fs.readText(path);
      holder = parseOperationLockRecord(JSON.parse(text) as unknown);
    } catch {
      holder = null;
    }

    if (holder !== null) {
      const alive = await adapters.process.isAlive(holder.pid, holder.processStartedAt);
      if (!alive) {
        // Stale recovery: remove and retry once without waiting forever.
        try {
          await adapters.fs.removeFile(path);
          recoveredStale = true;
          continue;
        } catch {
          // fall through to busy if we cannot clear
        }
      }
    } else {
      // Unparseable lock file — treat as stale and replace.
      try {
        await adapters.fs.removeFile(path);
        recoveredStale = true;
        continue;
      } catch {
        // busy
      }
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

    await sleep(adapters, pollIntervalMs);
  }
}

export async function releaseOperationLock(
  adapters: RuntimeAdapters,
  path: string,
  expectedOperationId: string,
): Promise<void> {
  try {
    if (!(await adapters.fs.exists(path))) return;
    const text = await adapters.fs.readText(path);
    const holder = parseOperationLockRecord(JSON.parse(text) as unknown);
    if (holder !== null && holder.operationId !== expectedOperationId) {
      // Do not remove a lock we do not own.
      return;
    }
  } catch {
    // Best-effort read; still try remove if we believe we own it.
  }
  await adapters.fs.removeFile(path);
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
    async release() {
      await releaseOperationLock(options.adapters, result.path, result.record.operationId);
    },
  };
  return { ...result, handle };
}

function sleep(adapters: RuntimeAdapters, ms: number): Promise<void> {
  return new Promise((resolve) => {
    adapters.timers.setTimeout(() => resolve(), ms);
  });
}
