import type { HostAdapters } from "../host/adapters.ts";
import {
  DEFAULT_DEV_INSTANCE_ID,
  DEV_CDP_HOST,
  DEV_CDP_PORT,
  DEV_DIRECTORY_MODE,
  DEV_STATE_FILE_MODE,
  DEV_STATE_FORBIDDEN_KEYS,
  DEV_STATE_SCHEMA_VERSION,
} from "./constants.ts";
import type { DevInstanceError, DevInstanceState, DevLayoutPaths } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function containsForbiddenKey(record: Record<string, unknown>): string | null {
  const forbidden = new Set<string>(DEV_STATE_FORBIDDEN_KEYS);
  for (const key of Object.keys(record)) {
    if (forbidden.has(key)) return key;
    // Nested secret-like fields are also rejected.
    const nested = record[key];
    if (isRecord(nested)) {
      const nestedHit = containsForbiddenKey(nested);
      if (nestedHit !== null) return nestedHit;
    }
  }
  return null;
}

function parseLastError(value: unknown): DevInstanceError | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (!isNonEmptyString(value.code)) return undefined;
  if (!isNonEmptyString(value.message)) return undefined;
  if (!isNonEmptyString(value.phase)) return undefined;
  return {
    code: value.code,
    message: value.message,
    phase: value.phase,
  };
}

/**
 * Parse development state from unknown. Malformed or secret-bearing records fail closed.
 */
export function parseDevInstanceState(value: unknown): DevInstanceState | null {
  if (!isRecord(value)) return null;
  const forbidden = containsForbiddenKey(value);
  if (forbidden !== null) return null;

  if (value.schemaVersion !== DEV_STATE_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(value.instanceId)) return null;
  if (value.role !== "development") return null;
  if (
    value.status !== "starting" &&
    value.status !== "ready" &&
    value.status !== "stopping" &&
    value.status !== "stopped" &&
    value.status !== "stale" &&
    value.status !== "failed"
  ) {
    return null;
  }
  if (!isNonEmptyString(value.rootPath)) return null;
  if (!isNonEmptyString(value.appPath)) return null;
  if (!isNonEmptyString(value.executablePath)) return null;
  if (!isNullableInteger(value.pid)) return null;
  if (!isNullableString(value.processStartedAt)) return null;
  if (typeof value.launchMarker !== "string") return null;
  if (!isNonEmptyString(value.electronUserDataPath)) return null;
  if (!isNonEmptyString(value.codexHomePath)) return null;
  if (!isNonEmptyString(value.explodexStatePath)) return null;
  if (!isNonEmptyString(value.logsPath)) return null;
  if (value.cdpHost !== DEV_CDP_HOST) return null;
  if (value.cdpPort !== DEV_CDP_PORT) return null;
  if (!isNullableString(value.targetId)) return null;
  if (!isNullableString(value.appVersion)) return null;
  if (!isNullableString(value.appBuild)) return null;
  if (!isNullableString(value.startedAt)) return null;
  if (!isNonEmptyString(value.updatedAt)) return null;

  const lastError = parseLastError(value.lastError);
  if (value.lastError !== undefined && lastError === undefined) return null;

  const state: DevInstanceState = {
    schemaVersion: 1,
    instanceId: value.instanceId,
    role: "development",
    status: value.status,
    rootPath: value.rootPath,
    appPath: value.appPath,
    executablePath: value.executablePath,
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    launchMarker: value.launchMarker,
    electronUserDataPath: value.electronUserDataPath,
    codexHomePath: value.codexHomePath,
    explodexStatePath: value.explodexStatePath,
    logsPath: value.logsPath,
    cdpHost: DEV_CDP_HOST,
    cdpPort: DEV_CDP_PORT,
    targetId: value.targetId,
    appVersion: value.appVersion,
    appBuild: value.appBuild,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
  if (lastError !== undefined) {
    state.lastError = lastError;
  }
  return state;
}

/** Build a stopped initial state for a newly created layout. No process is owned. */
export function createInitialDevInstanceState(options: {
  layout: DevLayoutPaths;
  appPath: string;
  executablePath: string;
  launchMarker?: string;
  updatedAt: string;
  instanceId?: string;
}): DevInstanceState {
  return {
    schemaVersion: 1,
    instanceId: options.instanceId ?? DEFAULT_DEV_INSTANCE_ID,
    role: "development",
    status: "stopped",
    rootPath: options.layout.rootPath,
    appPath: options.appPath,
    executablePath: options.executablePath,
    pid: null,
    processStartedAt: null,
    launchMarker: options.launchMarker ?? "",
    electronUserDataPath: options.layout.electronUserDataPath,
    codexHomePath: options.layout.codexHomePath,
    explodexStatePath: options.layout.explodexStatePath,
    logsPath: options.layout.logsPath,
    cdpHost: DEV_CDP_HOST,
    cdpPort: DEV_CDP_PORT,
    targetId: null,
    appVersion: null,
    appBuild: null,
    startedAt: null,
    updatedAt: options.updatedAt,
  };
}

export async function loadDevInstanceState(options: {
  adapters: HostAdapters;
  statePath: string;
}): Promise<DevInstanceState | null> {
  const exists = await options.adapters.fs.exists(options.statePath);
  if (!exists) return null;

  let text: string;
  try {
    if (options.adapters.fs.readText) {
      text = await options.adapters.fs.readText(options.statePath);
    } else {
      const bytes = await options.adapters.fs.readFile(options.statePath);
      text = new TextDecoder().decode(bytes);
    }
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return parseDevInstanceState(parsed);
}

/**
 * Atomically write mode-0600 development state.
 * A next command observes either the complete prior state or the complete new state.
 */
export async function saveDevInstanceState(options: {
  adapters: HostAdapters;
  statePath: string;
  state: DevInstanceState;
}): Promise<void> {
  const { adapters, statePath, state } = options;
  const parsed = parseDevInstanceState(state);
  if (parsed === null) {
    throw new Error("Refusing to persist invalid or secret-bearing development state");
  }
  if (!adapters.fs.mkdir || !adapters.fs.writeFile || !adapters.fs.rename) {
    throw new Error("Filesystem adapter must support mkdir/writeFile/rename to save development state");
  }

  const parent = statePath.includes("/")
    ? statePath.slice(0, statePath.lastIndexOf("/")) || "/"
    : ".";
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(parsed, null, 2)}\n`;
  const bytes = new TextEncoder().encode(payload);

  await adapters.fs.mkdir(parent, { recursive: true, mode: DEV_DIRECTORY_MODE });
  await adapters.fs.writeFile(tempPath, bytes);
  // Production writeFile uses mode 0600; memory fixtures seed 0600 as well.
  await adapters.fs.rename(tempPath, statePath);

  const stat = await adapters.fs.stat(statePath);
  if (stat.kind === "file" && stat.mode !== undefined) {
    // Accept either exact 0600 or OS-reported modes that include the permission bits.
    const modeBits = stat.mode & 0o777;
    if (modeBits !== DEV_STATE_FILE_MODE && modeBits !== 0) {
      // Soft check: some adapters may not preserve mode on rename; production Node writeFile does.
      if (modeBits !== DEV_STATE_FILE_MODE) {
        // Only reject world/group-readable private state when mode is known and too open.
        if ((modeBits & 0o077) !== 0) {
          throw new Error(
            `Development state mode must be private (0600); observed ${modeBits.toString(8)}`,
          );
        }
      }
    }
  }
}

/** Documented key set for public state exposure (VAL-DEV-003). */
export function publicDevStateKeySet(): readonly string[] {
  return [
    "schemaVersion",
    "instanceId",
    "role",
    "status",
    "rootPath",
    "appPath",
    "executablePath",
    "pid",
    "processStartedAt",
    "launchMarker",
    "electronUserDataPath",
    "codexHomePath",
    "explodexStatePath",
    "logsPath",
    "cdpHost",
    "cdpPort",
    "targetId",
    "appVersion",
    "appBuild",
    "lastError",
    "startedAt",
    "updatedAt",
  ] as const;
}
