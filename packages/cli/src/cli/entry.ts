import { dispatch } from "./dispatch.ts";
import { parseArgv } from "./parse.ts";
import {
  failureEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { createProcessIo, writeCliResult } from "../output/write.ts";
import { EXIT_FAILURE, EXIT_INTERRUPTED } from "./exit-codes.ts";
import { renderFailure } from "./errors.ts";

const INTERNAL_PUBLIC_MESSAGE = "An unexpected internal error occurred.";
const DEFAULT_DEV_PROVE_TIMEOUT_MS = 10 * 60 * 1_000;

export function resolveOperationBoundMs(options: {
  operation: string;
  timeoutMs: number;
  timeoutRaw: string | null;
}): number {
  return options.operation === "dev.prove" && options.timeoutRaw === null
    ? DEFAULT_DEV_PROVE_TIMEOUT_MS
    : options.timeoutMs;
}

export type RunCliOptions = {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  io?: ReturnType<typeof createProcessIo>;
  /** When true, do not call process.exit (for tests). */
  returnResult?: boolean;
};

/**
 * Public CLI entry used by the bin wrapper and tests.
 * After initialization begins, unexpected exceptions still yield one failure envelope.
 */
export async function runCli(options: RunCliOptions = {}): Promise<RenderedCliResult> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const io = options.io ?? createProcessIo();

  // Detect JSON mode early so even parse/internal failures stay machine-clean.
  let json = argvIncludesJson(argv);
  let initialized = false;
  let activeOperation = "cli.parse";
  let terminalCause: "interrupted" | "timeout" | null = null;
  let operationBoundMs = 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const operationAbort = new AbortController();

  const onInterrupt = (): void => {
    if (terminalCause !== null) return;
    terminalCause = "interrupted";
    operationAbort.abort();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  try {
    const parsed = parseArgv(argv);
    initialized = true;
    if (parsed.kind === "failure") {
      json = json || envelopeWantsJson(parsed.rendered) || argvIncludesJson(argv);
      writeCliResult(io, parsed.rendered, { json });
      if (!options.returnResult) process.exitCode = parsed.rendered.exitCode;
      return parsed.rendered;
    }

    json = parsed.globals.json;
    activeOperation = operationForParsed(parsed);
    operationBoundMs = resolveOperationBoundMs({
      operation: activeOperation,
      timeoutMs: parsed.globals.timeoutMs,
      timeoutRaw: parsed.globals.timeoutRaw,
    });
    const effectiveParsed = operationBoundMs === parsed.globals.timeoutMs
      ? parsed
      : {
          ...parsed,
          globals: {
            ...parsed.globals,
            timeoutMs: operationBoundMs,
          },
        };

    if (terminalCause === "interrupted") {
      const rendered = interruptedResult(activeOperation);
      writeCliResult(io, rendered, { json });
      if (!options.returnResult) process.exitCode = rendered.exitCode;
      return rendered;
    }

    if (shouldApplyOperationDeadline(effectiveParsed)) {
      timeoutHandle = setTimeout(() => {
        if (terminalCause !== null) return;
        terminalCause = "timeout";
        operationAbort.abort();
      }, operationBoundMs);
      timeoutHandle.unref?.();
    }

    const dispatched = await dispatch({
      parsed: effectiveParsed,
      env,
      io,
      signal: operationAbort.signal,
    });
    const rendered = classifyTerminalCause({
      rendered: dispatched,
      terminalCause,
      operation: activeOperation,
      boundMs: operationBoundMs,
    });

    writeCliResult(io, rendered, { json });
    if (!options.returnResult) process.exitCode = rendered.exitCode;
    return rendered;
  } catch (_error: unknown) {
    const rendered = terminalCause === "interrupted"
      ? interruptedResult(activeOperation)
      : terminalCause === "timeout"
        ? timeoutResult(activeOperation, operationBoundMs)
        : renderFailure({
          operation: activeOperation,
          code: "operation.internal",
          message: INTERNAL_PUBLIC_MESSAGE,
          details: initialized
            ? { stage: "dispatch" }
            : { stage: "initialization" },
          humanStderr: `error: ${INTERNAL_PUBLIC_MESSAGE}\nerror.code: operation.internal\n`,
          exitCode: EXIT_FAILURE,
        });
    writeCliResult(io, rendered, { json });
    if (!options.returnResult) process.exitCode = rendered.exitCode;
    return rendered;
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

function argvIncludesJson(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--json") return true;
  }
  return false;
}

function envelopeWantsJson(_rendered: RenderedCliResult): boolean {
  return false;
}

function interruptedResult(operation: string): RenderedCliResult {
  return {
    envelope: failureEnvelope(operation, {
      code: "operation.interrupted",
      message: "Operation interrupted.",
    }),
    exitCode: EXIT_INTERRUPTED,
    humanStdout: "",
    humanStderr: "Operation interrupted.\nerror.code: operation.interrupted\n",
  };
}

function timeoutResult(operation: string, boundMs: number): RenderedCliResult {
  return {
    envelope: failureEnvelope(operation, {
      code: "operation.timeout",
      message: "Operation timed out.",
      details: { boundMs },
    }),
    exitCode: 5,
    humanStdout: "",
    humanStderr: [
      `Operation timed out after ${boundMs}ms.`,
      "error.code: operation.timeout",
      "",
    ].join("\n"),
  };
}

function operationForParsed(parsed: ReturnType<typeof parseArgv> & { kind: "success" }): string {
  if (parsed.globals.help || (parsed.rootOnly && !parsed.globals.version)) return "help";
  if (parsed.globals.version) return "version";
  return parsed.resolved?.command.operation ?? "cli.parse";
}

function shouldApplyOperationDeadline(
  parsed: ReturnType<typeof parseArgv> & { kind: "success" },
): boolean {
  return !parsed.globals.help && !parsed.globals.version && !parsed.rootOnly;
}

export function classifyTerminalCause(options: {
  rendered: RenderedCliResult;
  terminalCause: "interrupted" | "timeout" | null;
  operation: string;
  boundMs: number;
}): RenderedCliResult {
  if (options.rendered.outputMode === "already-written") {
    return options.rendered;
  }
  if (options.terminalCause === null || options.rendered.envelope.ok) {
    return options.rendered;
  }
  if (options.rendered.envelope.error.code === "operation.interrupted") {
    if (options.terminalCause === "interrupted") {
      return options.rendered;
    }
    const timeout = timeoutResult(options.operation, options.boundMs);
    if (!timeout.envelope.ok) {
      const priorDetails = options.rendered.envelope.error.details;
      const timeoutDetails = timeout.envelope.error.details;
      timeout.envelope.error.details = {
        ...(isRecord(priorDetails) ? priorDetails : {}),
        ...(isRecord(timeoutDetails) ? timeoutDetails : {}),
      };
    }
    return timeout;
  }
  return options.rendered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
