/**
 * schemaVersion-1 one-shot JSON envelope (architecture §4.2, library/cli-surface.md).
 * Serialization is deterministic: fixed key order, secret-free plain data, compact UTF-8 + LF.
 */

export const CLI_SCHEMA_VERSION = 1 as const;

export type CliWarning = {
  code: string;
  message: string;
};

export type CliErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

export type CliSuccessEnvelope<T = unknown> = {
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  ok: true;
  operation: string;
  result: T;
  warnings: CliWarning[];
};

export type CliFailureEnvelope = {
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  ok: false;
  operation: string;
  error: CliErrorBody;
  warnings: CliWarning[];
};

export type CliJsonEnvelope<T = unknown> = CliSuccessEnvelope<T> | CliFailureEnvelope;

export type CliExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130;

export type RenderedCliResult = {
  envelope: CliJsonEnvelope;
  exitCode: CliExitCode;
  /** The command already emitted its distinct machine protocol. */
  outputMode?: "standard" | "already-written";
  /** Human primary result for stdout when not in JSON mode. Empty when only stderr matters. */
  humanStdout: string;
  /** Progress, warnings, errors, recovery for stderr. */
  humanStderr: string;
};

const SEMANTIC_CODE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

export function isSemanticErrorCode(code: string): boolean {
  return SEMANTIC_CODE_PATTERN.test(code);
}

/** Map frozen baseline codes to exit classifications (cli-surface.md). */
export function exitCodeForError(code: string): CliExitCode {
  switch (code) {
    case "usage.unknown-command":
    case "usage.unknown-option":
    case "usage.missing-argument":
    case "usage.invalid-value":
    case "usage.conflicting-options":
    case "config.invalid-environment":
    case "legacy.selection-required":
      return 2;
    case "usage.command-unavailable":
    case "operation.cancelled":
    case "compatibility.unproven":
    case "compatibility.probe-required":
    case "compatibility.drifted":
    case "main.authorization-required":
    case "main.authorization-expired":
    case "main.authorization-mismatch":
    case "main.authorization-replayed":
    case "main.hot-path-unavailable":
    case "main.lifecycle-protected":
    case "main.staged-artifact-changed":
    case "main.sdk-runtime-changed":
    case "develop.local-sdk-not-publishable":
    case "develop.publishable-rebuild-required":
    case "develop.dev-revalidation-required":
    case "cdp.target-lost":
    case "auth.required":
    case "plugin.review.required":
    case "plugin.review.unavailable":
    case "plugin.review.cancelled":
    case "plugin.update.cancelled":
    case "dev.ownership-uncertain":
    case "dev.recovery-required":
    case "release.authorization-required":
      return 3;
    case "operation.busy":
    case "operation.state-changed":
    case "plugin.state.busy":
    case "plugin.state.conflict":
    case "dev.instance-busy":
      return 4;
    case "operation.timeout":
      return 5;
    case "operation.interrupted":
      return 130;
    default:
      return 1;
  }
}

export function successEnvelope<T>(
  operation: string,
  result: T,
  warnings: CliWarning[] = [],
): CliSuccessEnvelope<T> {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: true,
    operation,
    result,
    warnings,
  };
}

export function failureEnvelope(
  operation: string,
  error: CliErrorBody,
  warnings: CliWarning[] = [],
): CliFailureEnvelope {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: false,
    operation,
    error,
    warnings,
  };
}

/**
 * Deterministic JSON serialization with exact key order from the frozen contract.
 * Never serializes undefined, non-finite numbers, raw Errors, or class instances.
 */
export function serializeEnvelope(envelope: CliJsonEnvelope): string {
  const body = envelope.ok
    ? {
        schemaVersion: envelope.schemaVersion,
        ok: true as const,
        operation: envelope.operation,
        result: sanitizeJsonValue(envelope.result),
        warnings: sanitizeWarnings(envelope.warnings),
      }
    : {
        schemaVersion: envelope.schemaVersion,
        ok: false as const,
        operation: envelope.operation,
        error: sanitizeError(envelope.error),
        warnings: sanitizeWarnings(envelope.warnings),
      };
  return `${JSON.stringify(body)}\n`;
}

function sanitizeWarnings(warnings: CliWarning[]): Array<{ code: string; message: string }> {
  return warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
  }));
}

function sanitizeError(error: CliErrorBody): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };
  if (error.details !== undefined) {
    out.details = sanitizeJsonValue(error.details);
  }
  return out;
}

const SECRET_KEY_PATTERN =
  /^(cookie|cookies|token|tokens|password|passwd|secret|authorization|auth|credential|credentials|api[_-]?key|session|websocket|wsUrl|webSocketDebuggerUrl)$/i;

/**
 * Recursively convert values to JSON-safe plain data.
 * Omits undefined, drops secret-shaped keys, rejects raw Error instances.
 */
export function sanitizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      const item = record[key];
      if (item === undefined) continue;
      out[key] = sanitizeJsonValue(item);
    }
    return out;
  }
  return String(value);
}
