import { dispatch } from "./dispatch.ts";
import { parseArgv } from "./parse.ts";
import {
  failureEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { createProcessIo, writeCliResult } from "../output/write.ts";
import { EXIT_FAILURE, EXIT_INTERRUPTED } from "./exit-codes.ts";
import { renderFailure } from "./errors.ts";

const SIGNAL_AWARE_OPERATIONS = new Set([
  "plugin.install",
  "plugin.refresh",
  "plugin.review",
  "plugin.update.check",
]);

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
  let interrupted = false;
  const operationAbort = new AbortController();

  const onInterrupt = (): void => {
    interrupted = true;
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

    if (interrupted) {
      const rendered = interruptedResult("cli.parse");
      writeCliResult(io, rendered, { json });
      if (!options.returnResult) process.exitCode = rendered.exitCode;
      return rendered;
    }

    const rendered = await dispatch({
      parsed,
      env,
      io,
      signal: operationAbort.signal,
    });
    if (
      interrupted &&
      !SIGNAL_AWARE_OPERATIONS.has(
        parsed.resolved?.command.operation ?? "",
      )
    ) {
      const interruptedRendered = interruptedResult(
        parsed.resolved?.command.operation ?? "cli.parse",
      );
      writeCliResult(io, interruptedRendered, { json });
      if (!options.returnResult) process.exitCode = interruptedRendered.exitCode;
      return interruptedRendered;
    }

    writeCliResult(io, rendered, { json });
    if (!options.returnResult) process.exitCode = rendered.exitCode;
    return rendered;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "An unexpected internal error occurred.";
    const rendered = renderFailure({
      operation: "operation.internal",
      code: "operation.internal",
      message,
      details: initialized
        ? { stage: "dispatch" }
        : { stage: "initialization" },
      humanStderr: `error: ${message}\nerror.code: operation.internal\n`,
      exitCode: EXIT_FAILURE,
    });
    // Ensure operation field matches frozen envelope shape.
    rendered.envelope = failureEnvelope("cli.internal", {
      code: "operation.internal",
      message,
      details: initialized ? { stage: "dispatch" } : { stage: "initialization" },
    });
    writeCliResult(io, rendered, { json });
    if (!options.returnResult) process.exitCode = rendered.exitCode;
    return rendered;
  } finally {
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
