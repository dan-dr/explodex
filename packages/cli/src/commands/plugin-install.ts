import { resolve } from "node:path";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { installLocalPluginArchive } from "../plugin/install.ts";

const OPERATION = "plugin.install";

function takeTarget(tokens: readonly string[]): {
  target: string | null;
  rest: string[];
  missing: boolean;
} {
  const rest: string[] = [];
  let target: string | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--target") {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("-")) {
        return { target, rest, missing: true };
      }
      target = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--target=")) {
      target = token.slice("--target=".length);
      continue;
    }
    rest.push(token);
  }
  return { target, rest, missing: false };
}

export async function runPluginInstall(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const parsed = takeTarget([...options.rest, ...options.endOfOptions]);
  if (parsed.missing) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: "Option --target requires a value.",
      usageLine: "Usage: explodex plugin install <archive> [--target <role>]",
      helpPath: "plugin install",
      details: { option: "--target" },
    });
  }
  const target = parsed.target ?? "none";
  if (target !== "none" && target !== "main" && target !== "development") {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Invalid --target value '${target}'.`,
      usageLine: "Usage: explodex plugin install <archive> [--target <role>]",
      helpPath: "plugin install",
      details: { option: "--target", value: target },
    });
  }
  const unexpected = parsed.rest.filter((token) => token.startsWith("-"));
  if (unexpected.length > 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.unknown-option",
      message: `Unexpected option '${unexpected[0]}'.`,
      usageLine: "Usage: explodex plugin install <archive> [--target <role>]",
      helpPath: "plugin install",
      details: { option: unexpected[0] },
    });
  }
  if (parsed.rest.length !== 1) {
    return usageFailure({
      operation: OPERATION,
      code: parsed.rest.length === 0 ? "usage.missing-argument" : "usage.invalid-value",
      message: parsed.rest.length === 0
        ? "A prebuilt plugin archive is required."
        : `Unexpected extra argument '${parsed.rest[1]}'.`,
      usageLine: "Usage: explodex plugin install <archive> [--target <role>]",
      helpPath: "plugin install",
    });
  }

  const cwd = options.env.PWD ?? process.cwd();
  const archivePath = resolve(cwd, parsed.rest[0]!);
  let explodexHome: string;
  try {
    explodexHome = resolveExplodexHome({
      osHome: options.env.HOME,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    });
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.install.home-invalid",
      message: error instanceof Error ? error.message : "Unable to resolve Explodex home.",
    });
  }
  const result = await installLocalPluginArchive({
    archivePath,
    explodexHome,
    signal: options.signal,
  });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: {
        ...result.details,
        artifactCommitted: result.artifactCommitted,
        ...(result.stateCommitted === undefined
          ? {}
          : { stateCommitted: result.stateCommitted }),
        ...(result.completedMutation === undefined
          ? {}
          : { completedMutation: result.completedMutation }),
        ...(result.artifactPath === undefined ? {} : { artifactPath: result.artifactPath }),
      },
      exitCode: exitCodeForError(result.code),
      humanStderr: `${result.message}\nerror.code: ${result.code}\n`,
    });
  }

  const payload = {
    id: result.id,
    version: result.version,
    payloadSha256: result.payloadSha256,
    archiveSha256: result.archiveSha256,
    archiveRootName: result.archiveRootName,
    lifecycle: result.lifecycle,
    sdkRange: result.sdkRange,
    files: result.files,
    artifactPath: result.artifactPath,
    relativePath: result.relativePath,
    source: result.source,
    sourceLabel: result.sourceLabel,
    outcome: result.outcome,
    installed: true,
    artifactCommitted: result.artifactCommitted,
    stateCommitted: result.stateCommitted,
    activationChanged: result.activationChanged,
    enabled: result.enabled,
    pendingReview: result.pendingReview,
    target,
    transportTrust: "computed-local-archive-not-publisher-authenticated" as const,
  };
  if (result.pendingReview && target !== "none") {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.review.unavailable",
      message:
        "The plugin is installed, disabled, pending review, and source-absent because renderer review is unavailable.",
      details: payload,
      exitCode: 3,
      humanStderr: [
        "Plugin installation completed disabled and pending review.",
        "Renderer review is unavailable; no plugin source was delivered.",
        "error.code: plugin.review.unavailable",
        "",
      ].join("\n"),
    });
  }
  const human = [
    `${result.outcome === "already-installed" ? "Already installed" : result.outcome === "rediscovered" ? "Rediscovered" : "Installed"} plugin: ${result.id}@${result.version}`,
    `  payloadSha256: ${result.payloadSha256}`,
    `  archiveSha256: ${result.archiveSha256} (computed from the local archive; not publisher-authenticated)`,
    `  artifact: ${result.artifactPath}`,
    `  source: ${result.sourceLabel}`,
    result.enabled
      ? "  authority: unchanged (this exact identity was already enabled before reinstall)"
      : result.pendingReview
        ? "  enabled: no (pending separate review)"
        : "  authority: unchanged",
    "",
  ].join("\n");
  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}
