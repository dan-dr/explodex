import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  createProductionDevelopAdapters,
} from "../dev/develop-production.ts";
import { runForegroundDevelop } from "../dev/develop-operation.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  failureEnvelope,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import type { CliIo } from "../output/write.ts";

const OPERATION = "plugin.develop";

type ParsedDevelopArgs =
  | { ok: true; workspace: string | null; sdkSource: string | null }
  | { ok: false; rendered: RenderedCliResult };

function parseDevelopArgs(
  rest: readonly string[],
  endOfOptions: readonly string[],
): ParsedDevelopArgs {
  let workspace: string | null = null;
  let sdkSource: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--sdk-source" || token.startsWith("--sdk-source=")) {
      const value = token === "--sdk-source"
        ? rest[index + 1]
        : token.slice("--sdk-source=".length);
      if (value === undefined || value.length === 0) {
        return {
          ok: false,
          rendered: usageFailure({
            operation: OPERATION,
            code: "usage.missing-argument",
            message: "Option --sdk-source requires a path.",
            usageLine:
              "Usage: explodex plugin develop [workspace] [--sdk-source <path>]",
            helpPath: "plugin develop",
          }),
        };
      }
      if (sdkSource !== null && sdkSource !== value) {
        return {
          ok: false,
          rendered: usageFailure({
            operation: OPERATION,
            code: "usage.conflicting-options",
            message: "Conflicting --sdk-source values.",
            helpPath: "plugin develop",
          }),
        };
      }
      sdkSource = value;
      if (token === "--sdk-source") index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return {
        ok: false,
        rendered: usageFailure({
          operation: OPERATION,
          code: "usage.unknown-option",
          message: `Unexpected option '${token}'.`,
          helpPath: "plugin develop",
        }),
      };
    }
    if (workspace !== null) {
      return {
        ok: false,
        rendered: usageFailure({
          operation: OPERATION,
          code: "usage.invalid-value",
          message: `Unexpected extra argument '${token}'.`,
          helpPath: "plugin develop",
        }),
      };
    }
    workspace = token;
  }
  for (const token of endOfOptions) {
    if (workspace !== null) {
      return {
        ok: false,
        rendered: usageFailure({
          operation: OPERATION,
          code: "usage.invalid-value",
          message: `Unexpected extra argument '${token}'.`,
          helpPath: "plugin develop",
        }),
      };
    }
    workspace = token;
  }
  return { ok: true, workspace, sdkSource };
}

export async function runPluginDevelop(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const parsed = parseDevelopArgs(options.rest, options.endOfOptions);
  if (!parsed.ok) return parsed.rendered;
  const osHome = options.env.HOME;
  if (osHome === undefined || osHome.length === 0) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: "HOME is required for foreground plugin development.",
    });
  }
  const cwd = resolve(options.env.PWD ?? process.cwd());
  const workspacePath = resolve(cwd, parsed.workspace ?? ".");
  const sdkSourcePath = parsed.sdkSource === null
    ? null
    : resolve(cwd, parsed.sdkSource);
  let explodexHome: string;
  try {
    explodexHome = resolveExplodexHome({
      osHome,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    });
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const operationId = `develop-${randomUUID()}`;
  const foregroundAbort = new AbortController();
  const onForegroundSignal = (): void => foregroundAbort.abort();
  process.once("SIGINT", onForegroundSignal);
  process.once("SIGTERM", onForegroundSignal);
  let result: Awaited<ReturnType<typeof runForegroundDevelop>>;
  try {
    const adapters = await createProductionDevelopAdapters({
      workspacePath,
      sdkSourcePath,
      osHome,
      explodexHome,
      explicitRoot:
        options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
      timeoutMs: options.globals.timeoutMs,
      signal: foregroundAbort.signal,
      writeLine(line) {
        if (options.globals.json) options.io.stdout.write(`${line}\n`);
      },
    });
    result = await runForegroundDevelop({
      operationId,
      signal: foregroundAbort.signal,
      adapters,
    });
  } finally {
    process.removeListener("SIGINT", onForegroundSignal);
    process.removeListener("SIGTERM", onForegroundSignal);
  }
  const exitCode = result.ok
    ? 0
    : exitCodeForError(result.error?.code ?? "develop.runtime-failed");
  if (options.globals.json) {
    return {
      envelope: result.ok
        ? successEnvelope(OPERATION, { operationId })
        : failureEnvelope(OPERATION, result.error ?? {
            code: "develop.runtime-failed",
            message: "Foreground development failed.",
          }),
      exitCode,
      humanStdout: "",
      humanStderr: "",
      outputMode: "already-written",
    };
  }
  if (result.ok) {
    return {
      envelope: successEnvelope(OPERATION, result),
      exitCode: 0,
      humanStdout: [
        "Foreground plugin development completed.",
        `operationId: ${result.operationId}`,
        `lastSequence: ${result.lastSequence}`,
        "",
      ].join("\n"),
      humanStderr: "",
    };
  }
  return {
    envelope: failureEnvelope(OPERATION, result.error ?? {
      code: "develop.runtime-failed",
      message: "Foreground development failed.",
    }),
    exitCode,
    humanStdout: "",
    humanStderr: [
      result.error?.message ?? "Foreground development failed.",
      `error.code: ${result.error?.code ?? "develop.runtime-failed"}`,
      "",
    ].join("\n"),
  };
}
