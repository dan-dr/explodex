import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import type { CliIo } from "../output/write.ts";
import {
  runUpdateOnDeclaredTarget,
} from "../plugin/update-target.ts";
import {
  fetchSelectedPluginUpdateArchive,
  loadPluginUpdateRecommendations,
} from "../plugin/update-source.ts";
import { openPostOperationManagement } from "./post-operation-management.ts";

const OPERATION = "plugin.update.apply";

function parseTarget(tokens: readonly string[]):
  | { ok: true; target: "main" | "development" }
  | { ok: false; code: string; message: string } {
  let target: "main" | "development" = "main";
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
        };
      }
      if (value !== "main" && value !== "development") {
        return {
          ok: false,
          code: "usage.invalid-value",
          message: `Invalid --target value '${value}'.`,
        };
      }
      target = value;
      continue;
    }
    return {
      ok: false,
      code: token.startsWith("-")
        ? "usage.unknown-option"
        : "usage.invalid-value",
      message: `Unexpected argument or option '${token}'.`,
    };
  }
  return { ok: true, target };
}

export async function runPluginUpdateApply(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const parsed = parseTarget([...options.rest, ...options.endOfOptions]);
  if (!parsed.ok) {
    return usageFailure({
      operation: OPERATION,
      code: parsed.code,
      message: parsed.message,
      usageLine: "Usage: explodex plugin update apply [--target <role>]",
      helpPath: "plugin update apply",
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
      code: "plugin.update.home-invalid",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const configured = options.env.EXPLODEX_PLUGIN_UPDATE_RECOMMENDATIONS;
  if (configured === undefined || configured.length === 0) {
    return {
      envelope: successEnvelope(OPERATION, {
        status: "not-configured",
        target: parsed.target,
        reviewed: [],
        selected: [],
        downloaded: [],
        stateChanged: false,
        sourceDelivered: false,
      }),
      exitCode: 0,
      humanStdout:
        "No plugin update recommendation source is configured.\n",
      humanStderr: "",
    };
  }
  let recommendations: readonly unknown[];
  try {
    recommendations = await loadPluginUpdateRecommendations(resolve(
      options.env.PWD ?? process.cwd(),
      configured,
    ));
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.update.invalid-recommendation",
      message: error instanceof Error
        ? error.message
        : "Unable to load update recommendations.",
    });
  }
  if (parsed.target === "main") {
    return renderFailure({
      operation: OPERATION,
      code: "main.authorization-required",
      message:
        "Plugin update application to the protected main requires a fresh explicit authorization checkpoint; use --target development for this workflow.",
      exitCode: 3,
    });
  }
  if (
    recommendations.length > 0 &&
    (
      options.globals.json ||
      !options.io.stdinIsTty ||
      !options.io.stdoutIsTty
    )
  ) {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.update.unavailable",
      message:
        "Interactive renderer update consent requires a foreground TTY; no artifact was downloaded.",
      exitCode: 3,
    });
  }
  const result = await runUpdateOnDeclaredTarget({
    role: parsed.target,
    explodexHome: home,
    devRoot: options.globals.devRoot ?? undefined,
    env: options.env,
    recommendations,
    fetchArchive: fetchSelectedPluginUpdateArchive,
    timeoutMs: options.globals.timeoutMs,
    signal: options.signal,
  });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: result,
      exitCode: exitCodeForError(result.code),
    });
  }
  const management = await openPostOperationManagement({
    globals: options.globals,
    env: options.env,
    explodexHome: home,
    target: parsed.target,
    signal: options.signal,
  });
  return {
    envelope: successEnvelope(
      OPERATION,
      {
        ...result,
        targetRole: parsed.target,
        management,
      },
      management.warning === null ? [] : [management.warning],
    ),
    exitCode: 0,
    humanStdout: [
      `Plugin updates reviewed: ${result.reviewed.length}`,
      `Plugin updates selected: ${result.selected.length}`,
      `Plugin updates downloaded: ${result.downloaded.length}`,
      `Application results: ${result.applications.length}`,
      management.humanLine,
      "",
    ].join("\n"),
    humanStderr: "",
  };
}
