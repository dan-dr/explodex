import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  successEnvelope,
  type CliExitCode,
  type RenderedCliResult,
} from "../output/envelope.ts";
import type { CliIo } from "../output/write.ts";
import { loadPendingReviewMetadata } from "../plugin/review-metadata.ts";
import {
  selectPendingReviewArtifacts,
  type ReviewArtifact,
} from "../plugin/review-protocol.ts";
import { runReviewOnDeclaredTarget } from "../plugin/review-target.ts";

const OPERATION = "plugin.review";

export type ReviewEntryResult =
  | {
      ok: true;
      status: "not-required" | "submitted";
      reviewed: ReviewArtifact[];
      selected: Array<{
        id: string;
        version: string;
        payloadSha256: string;
      }>;
      target: "main" | "development";
      sourceDelivered: false;
      authorityChanged: false;
      protocol?: {
        operationId: string;
        callbackName: string;
        nonce: string;
        expiresAtMs: number;
        target: unknown;
      };
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      exitCode?: CliExitCode;
      sourceDelivered: false;
      authorityChanged: false;
    };

function parseReviewArgs(tokens: readonly string[]):
  | {
      ok: true;
      id?: string;
      version?: string;
      payloadSha256?: string;
      target: "main" | "development";
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    } {
  const positionals: string[] = [];
  let version: string | undefined;
  let payloadSha256: string | undefined;
  let target: "main" | "development" = "main";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const option = token.startsWith("--") ? token.split("=", 1)[0] : null;
    if (
      option === "--artifact-version" ||
      option === "--payload-sha256" ||
      option === "--target"
    ) {
      const inline = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : undefined;
      const value = inline ?? tokens[++index];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        return {
          ok: false,
          code: "usage.missing-argument",
          message: `Option ${option} requires a value.`,
          details: { option },
        };
      }
      if (option === "--artifact-version") version = value;
      if (option === "--payload-sha256") payloadSha256 = value;
      if (option === "--target") {
        if (value !== "main" && value !== "development") {
          return {
            ok: false,
            code: "usage.invalid-value",
            message: `Invalid --target value '${value}'.`,
            details: { option, value },
          };
        }
        target = value;
      }
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
  if (positionals.length > 1) {
    return {
      ok: false,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${positionals[1]}'.`,
    };
  }
  return {
    ok: true,
    ...(positionals[0] === undefined ? {} : { id: positionals[0] }),
    ...(version === undefined ? {} : { version }),
    ...(payloadSha256 === undefined ? {} : { payloadSha256 }),
    target,
  };
}

export async function performPendingPluginReview(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  explodexHome: string;
  pending: readonly ReviewArtifact[];
  request: {
    id?: string;
    version?: string;
    payloadSha256?: string;
  };
  target: "main" | "development";
  signal?: AbortSignal;
}): Promise<ReviewEntryResult> {
  const selected = selectPendingReviewArtifacts({
    pending: options.pending,
    request: options.request,
  });
  if (!selected.ok) {
    return {
      ok: false,
      code: selected.code,
      message: selected.message,
      exitCode: selected.code === "plugin.review.exact-selection-required" ||
          selected.code === "plugin.review.id-required" ||
          selected.code === "plugin.review.incomplete-identity"
        ? 2
        : 3,
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  if (selected.artifacts.length === 0) {
    return {
      ok: true,
      status: "not-required",
      reviewed: [],
      selected: [],
      target: options.target,
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  if (
    options.globals.json ||
    !options.io.stdinIsTty ||
    !options.io.stdoutIsTty
  ) {
    return {
      ok: false,
      code: "plugin.review.unavailable",
      message:
        "Interactive renderer review requires a foreground TTY. Pending identities remain disabled and source-absent.",
      details: {
        target: options.target,
        pending: selected.artifacts,
        reason: options.globals.json ? "json-mode" : "no-tty",
      },
      exitCode: 3,
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  const operation = await runReviewOnDeclaredTarget({
    role: options.target,
    explodexHome: options.explodexHome,
    devRoot: options.globals.devRoot ?? undefined,
    env: options.env,
    artifacts: selected.artifacts,
    timeoutMs: options.globals.timeoutMs,
    signal: options.signal,
  });
  if (!operation.ok) {
    const code = operation.code === "operation_timeout"
      ? "operation.timeout"
      : operation.code === "operation_interrupted"
        ? "operation.interrupted"
        : operation.code.endsWith("_identity_drift")
          ? "cdp.target-lost"
          : operation.code;
    return {
      ok: false,
      code,
      message: operation.message,
      details: {
        ...operation.details,
        operationId: operation.operationId,
      },
      exitCode: exitCodeForError(code),
      sourceDelivered: false,
      authorityChanged: false,
    };
  }
  return {
    ok: true,
    status: "submitted",
    reviewed: operation.reviewed,
    selected: operation.selected,
    target: options.target,
    sourceDelivered: false,
    authorityChanged: false,
    protocol: {
      operationId: operation.operationId,
      callbackName: operation.protocol.callbackName,
      nonce: operation.protocol.nonce,
      expiresAtMs: operation.protocol.expiresAtMs,
      target: operation.protocol.target,
    },
  };
}

export async function runPluginReview(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const parsed = parseReviewArgs([...options.rest, ...options.endOfOptions]);
  if (!parsed.ok) {
    return usageFailure({
      operation: OPERATION,
      code: parsed.code,
      message: parsed.message,
      usageLine:
        "Usage: explodex plugin review [id] [--artifact-version <opaque-version>] [--payload-sha256 <hex>] [--target <role>]",
      helpPath: "plugin review",
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
      code: "plugin.review.home-invalid",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const metadata = await loadPendingReviewMetadata({
    explodexHome: home,
    signal: options.signal,
  });
  if (!metadata.ok) {
    return renderFailure({
      operation: OPERATION,
      code: metadata.code,
      message: metadata.message,
      exitCode: exitCodeForError(metadata.code),
    });
  }
  const result = await performPendingPluginReview({
    globals: options.globals,
    env: options.env,
    io: options.io,
    explodexHome: home,
    pending: metadata.pending,
    request: {
      ...(parsed.id === undefined ? {} : { id: parsed.id }),
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      ...(parsed.payloadSha256 === undefined
        ? {}
        : { payloadSha256: parsed.payloadSha256 }),
    },
    target: parsed.target,
    signal: options.signal,
  });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: {
        ...result.details,
        invalid: metadata.invalid,
        sourceDelivered: result.sourceDelivered,
        authorityChanged: result.authorityChanged,
      },
      exitCode: result.exitCode ?? exitCodeForError(result.code),
      humanStderr: `${result.message}\nerror.code: ${result.code}\n`,
    });
  }
  const payload = {
    status: result.status,
    target: result.target,
    reviewed: result.reviewed,
    selected: result.selected,
    invalid: metadata.invalid,
    sourceDelivered: result.sourceDelivered,
    authorityChanged: result.authorityChanged,
    ...(result.protocol === undefined ? {} : { protocol: result.protocol }),
  };
  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: 0,
    humanStdout: result.status === "not-required"
      ? "No pending plugin identities require review.\n"
      : [
          `Plugin review submitted: ${result.selected.length} selected`,
          "Selection was validated for this operation; executable source remains absent until the approval transaction commits authority.",
          "",
        ].join("\n"),
    humanStderr: "",
  };
}
