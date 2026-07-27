import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { createDeclaredTargetPluginTeardown } from "../plugin/mutation-target.ts";
import {
  removeInstalledPlugin,
  type PluginMutationIdentity,
} from "../plugin/mutation-transaction.ts";

const OPERATION = "plugin.remove";

function parseArgs(tokens: readonly string[]):
  | {
      ok: true;
      id: string;
      identity?: PluginMutationIdentity;
      target: "none" | "main" | "development";
    }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> } {
  const positionals: string[] = [];
  let version: string | undefined;
  let payloadSha256: string | undefined;
  let target: "none" | "main" | "development" = "none";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const option = token.startsWith("--") ? token.split("=", 1)[0] : null;
    if (
      option === "--artifact-version" ||
      option === "--payload-sha256" ||
      option === "--target"
    ) {
      const value = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : tokens[++index];
      if (value === undefined || value.length === 0) {
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
        if (
          value !== "none" &&
          value !== "main" &&
          value !== "development"
        ) {
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
  const id = positionals[0]!;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    return {
      ok: false,
      code: "usage.invalid-value",
      message: `Invalid plugin ID '${id}'.`,
    };
  }
  if ((version === undefined) !== (payloadSha256 === undefined)) {
    return {
      ok: false,
      code: "usage.conflicting-options",
      message:
        "Exact removal requires both --artifact-version and --payload-sha256.",
    };
  }
  if (
    version !== undefined &&
    (version.trim() !== version ||
      version.length === 0 ||
      version === "." ||
      version === ".." ||
      /[\u0000-\u001f\u007f/\\]/u.test(version))
  ) {
    return {
      ok: false,
      code: "usage.invalid-value",
      message: "--artifact-version is not a safe exact opaque version.",
    };
  }
  if (
    payloadSha256 !== undefined &&
    !/^[a-f0-9]{64}$/u.test(payloadSha256)
  ) {
    return {
      ok: false,
      code: "usage.invalid-value",
      message: "--payload-sha256 must be exactly 64 lowercase hexadecimal characters.",
    };
  }
  return {
    ok: true,
    id,
    ...(version === undefined || payloadSha256 === undefined
      ? {}
      : {
          identity: {
            version,
            payloadSha256,
          },
        }),
    target,
  };
}

export async function runPluginRemove(options: {
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
      usageLine:
        "Usage: explodex plugin remove <id> [--artifact-version <opaque-version>] [--payload-sha256 <hex>] [--target <role>]",
      helpPath: "plugin remove",
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
      code: "plugin.remove.home-invalid",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const result = await removeInstalledPlugin({
    explodexHome: home,
    id: parsed.id,
    ...(parsed.identity === undefined ? {} : { identity: parsed.identity }),
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
        removed: result.removed,
        stateCommitted: result.stateCommitted,
        authorityChanged: result.authorityChanged,
        artifactDeleted: result.artifactDeleted,
        orphanedDirectory: result.orphanedDirectory,
        mutation: result.mutation,
      },
      exitCode: exitCodeForError(result.code),
    });
  }
  return {
    envelope: successEnvelope(OPERATION, {
      target: parsed.target,
      removed: result.removed,
      stateCommitted: result.stateCommitted,
      authorityChanged: result.authorityChanged,
      artifactDeleted: result.artifactDeleted,
      orphanedDirectory: result.orphanedDirectory,
      mutation: result.mutation,
    }),
    exitCode: 0,
    humanStdout: [
      `Removed plugin '${parsed.id}' ${result.removed.version} ${result.removed.payloadSha256}.`,
      `Application: ${result.mutation.application.status}`,
      result.mutation.application.message ?? "",
      "",
    ].filter((line, index, lines) =>
      line.length > 0 || index === lines.length - 1
    ).join("\n"),
    humanStderr: "",
  };
}
