import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { disableInstalledPlugin } from "../plugin/mutation-transaction.ts";
import { createDeclaredTargetPluginTeardown } from "../plugin/mutation-target.ts";

const OPERATION = "plugin.disable";

function parseArgs(tokens: readonly string[]):
  | { ok: true; id: string; target: "none" | "main" | "development" }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> } {
  const positionals: string[] = [];
  let target: "none" | "main" | "development" = "none";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--target" || token.startsWith("--target=")) {
      const value = token === "--target"
        ? tokens[++index]
        : token.slice("--target=".length);
      if (value === undefined || value.length === 0) {
        return {
          ok: false,
          code: "usage.missing-argument",
          message: "Option --target requires a value.",
          details: { option: "--target" },
        };
      }
      if (
        value !== "none" &&
        value !== "main" &&
        value !== "development"
      ) {
        return {
          ok: false,
          code: "usage.invalid-value",
          message: `Invalid --target value '${value}'.`,
          details: { option: "--target", value },
        };
      }
      target = value;
      continue;
    }
    if (token.startsWith("-")) {
      return {
        ok: false,
        code: "usage.unknown-option",
        message: `Unexpected option '${token}'.`,
        details: { option: token },
      };
    }
    positionals.push(token);
  }
  if (positionals.length === 0) {
    return {
      ok: false,
      code: "usage.missing-argument",
      message: "Plugin ID is required.",
    };
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${positionals[1]}'.`,
    };
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(positionals[0]!)) {
    return {
      ok: false,
      code: "usage.invalid-value",
      message: `Invalid plugin ID '${positionals[0]}'.`,
    };
  }
  return { ok: true, id: positionals[0]!, target };
}

export async function runPluginDisable(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const parsed = parseArgs([...options.rest, ...options.endOfOptions]);
  if (!parsed.ok) {
    return usageFailure({
      operation: OPERATION,
      code: parsed.code,
      message: parsed.message,
      usageLine: "Usage: explodex plugin disable <id> [--target <role>]",
      helpPath: "plugin disable",
      details: parsed.details,
    });
  }
  let home: string;
  try {
    home = resolve(resolveExplodexHome({
      osHome: options.env.HOME,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    }));
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.disable.home-invalid",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const result = await disableInstalledPlugin({
    explodexHome: home,
    id: parsed.id,
    signal: options.signal,
    ...(parsed.target === "none"
      ? {}
      : {
          teardown: createDeclaredTargetPluginTeardown({
            role: parsed.target,
            explodexHome: home,
            devRoot: options.globals.devRoot ?? undefined,
            env: options.env,
            timeoutMs: options.globals.timeoutMs,
            signal: options.signal,
          }),
        }),
  });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: {
        ...result.details,
        target: parsed.target,
        stateCommitted: result.stateCommitted,
        authorityChanged: result.authorityChanged,
        mutation: result.mutation,
      },
      exitCode: exitCodeForError(result.code),
    });
  }
  return {
    envelope: successEnvelope(OPERATION, {
      target: parsed.target,
      stateCommitted: result.stateCommitted,
      authorityChanged: result.authorityChanged,
      mutation: result.mutation,
    }),
    exitCode: 0,
    humanStdout: [
      result.authorityChanged
        ? `Disabled plugin '${parsed.id}'.`
        : `Plugin '${parsed.id}' was already disabled.`,
      `Application: ${result.mutation.application.status}`,
      result.mutation.application.message ?? "",
      "",
    ].filter((line, index, lines) =>
      line.length > 0 || index === lines.length - 1
    ).join("\n"),
    humanStderr: "",
  };
}
