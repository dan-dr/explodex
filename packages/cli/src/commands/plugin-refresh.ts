import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { discoverInstalledPlugins } from "../plugin/discovery.ts";
import { performPendingPluginReview } from "./plugin-review.ts";
import type { CliIo } from "../output/write.ts";

const OPERATION = "plugin.refresh";

function parseTarget(tokens: readonly string[]): {
  target: "none" | "main" | "development" | null;
  rest: string[];
} {
  let target: "none" | "main" | "development" | null = "none";
  const rest: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const value = token === "--target"
      ? tokens[++index]
      : token.startsWith("--target=")
        ? token.slice("--target=".length)
        : null;
    if (value === null) {
      rest.push(token);
      continue;
    }
    if (value !== "none" && value !== "main" && value !== "development") {
      return { target: null, rest: [value] };
    }
    target = value;
  }
  return { target, rest };
}

export async function runPluginRefresh(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const parsed = parseTarget([...options.rest, ...options.endOfOptions]);
  if (parsed.target === null) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Invalid --target value '${parsed.rest[0] ?? ""}'.`,
      usageLine: "Usage: explodex plugin refresh [--target <role>]",
      helpPath: "plugin refresh",
    });
  }
  if (parsed.rest.length > 0) {
    return usageFailure({
      operation: OPERATION,
      code: parsed.rest[0]?.startsWith("-")
        ? "usage.unknown-option"
        : "usage.invalid-value",
      message: `Unexpected argument or option '${parsed.rest[0]}'.`,
      usageLine: "Usage: explodex plugin refresh [--target <role>]",
      helpPath: "plugin refresh",
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
      code: "plugin.refresh.home-invalid",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const result = await discoverInstalledPlugins({
    explodexHome: home,
    trigger: "refresh",
    signal: options.signal,
  });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: {
        ...result.details,
        ...(result.completedDiscovery === undefined
          ? {}
          : { completedDiscovery: result.completedDiscovery }),
      },
      exitCode: exitCodeForError(result.code),
    });
  }
  const payload = {
    trigger: result.trigger,
    recovery: result.recovery,
    stateChanged: result.stateChanged,
    newlyRecorded: result.newlyRecorded,
    pending: result.pending,
    invalid: result.invalid,
    rendererRequested: result.rendererRequested,
    sourceDelivered: result.sourceDelivered,
    review: {
      status: result.pending.length === 0
        ? "not-required"
        : parsed.target === "none"
          ? "required"
          : "unavailable",
      target: parsed.target,
    },
  };
  if (result.pending.length > 0 && parsed.target !== "none") {
    const review = await performPendingPluginReview({
      globals: options.globals,
      env: options.env,
      io: options.io,
      explodexHome: home,
      pending: result.pending,
      request: {},
      target: parsed.target,
      signal: options.signal,
    });
    if (!review.ok) {
      return renderFailure({
        operation: OPERATION,
        code: review.code,
        message: review.message,
        details: {
          ...payload,
          ...review.details,
          sourceDelivered: review.sourceDelivered,
          authorityChanged: review.authorityChanged,
        },
        exitCode: review.exitCode ?? exitCodeForError(review.code),
        humanStderr: `${review.message}\nerror.code: ${review.code}\n`,
      });
    }
    return {
      envelope: successEnvelope(OPERATION, {
        ...payload,
        review,
      }),
      exitCode: 0,
      humanStdout: [
        `Plugin refresh: ${result.pending.length} pending, ${result.invalid.length} invalid`,
        review.status === "approved"
          ? `Approval committed: ${review.selected.length} selected`
          : "Review submitted with an empty selection",
        review.status === "approved"
          ? `Application results: ${review.applications.length}`
          : "Activation authority was unchanged.",
        "",
      ].join("\n"),
      humanStderr: "",
    };
  }
  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: 0,
    humanStdout: [
      `Plugin refresh: ${result.pending.length} pending, ${result.invalid.length} invalid`,
      result.pending.length === 0
        ? "No review is required."
        : "Review is required; pending identities remain disabled and source-absent.",
      "",
    ].join("\n"),
    humanStderr: "",
  };
}
