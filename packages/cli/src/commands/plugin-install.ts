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
import { ingestLocalPluginArchive } from "../plugin/installer.ts";

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
  if (target !== "none") {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.install.target-unavailable",
      message: "M3-F01 validates archives only; renderer review targets are introduced by later plugin-activation features.",
      details: { target },
      exitCode: 1,
      humanStderr:
        "Archive validation completed only with --target none in this release.\n" +
        "error.code: plugin.install.target-unavailable\n",
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
  const stagingParent = resolve(explodexHome, "plugins", ".staging");
  const result = await ingestLocalPluginArchive({ archivePath, stagingParent });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: result.details,
      exitCode: exitCodeForError(result.code),
      humanStderr: `${result.message}\nerror.code: ${result.code}\n`,
    });
  }

  try {
    const payload = {
      id: result.id,
      version: result.version,
      payloadSha256: result.payloadSha256,
      archiveSha256: result.archiveSha256,
      archiveRootName: result.archiveRootName,
      lifecycle: result.lifecycle,
      sdkRange: result.sdkRange,
      files: result.files,
      installed: false,
      committed: false,
      target: "none" as const,
      validation: "precommit-complete" as const,
    };
    const human = [
      `Validated plugin archive for installation: ${result.id}@${result.version}`,
      `  payloadSha256: ${result.payloadSha256}`,
      `  archiveSha256: ${result.archiveSha256}`,
      "  committed: no (immutable installation/state authority is introduced by M3-F02)",
      "",
    ].join("\n");
    return {
      envelope: successEnvelope(OPERATION, payload),
      exitCode: EXIT_SUCCESS,
      humanStdout: human,
      humanStderr: "",
    };
  } finally {
    await result.cleanup();
  }
}
