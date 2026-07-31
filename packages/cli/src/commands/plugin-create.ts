import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { createPluginWorkspace } from "../plugin/create.ts";

const OPERATION = "plugin.create";

export async function runPluginCreate(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const positionals = [...options.rest, ...options.endOfOptions];
  const unexpected = positionals.filter((token) => token.startsWith("-"));
  if (unexpected.length > 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.unknown-option",
      message: `Unexpected option '${unexpected[0]}'.`,
      usageLine: "Usage: explodex plugin create <directory>",
      helpPath: "plugin create",
      details: { option: unexpected[0] },
    });
  }

  if (positionals.length === 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: "plugin create requires a <directory> argument.",
      usageLine: "Usage: explodex plugin create <directory>",
      helpPath: "plugin create",
    });
  }
  if (positionals.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${positionals[1]}'.`,
      usageLine: "Usage: explodex plugin create <directory>",
      helpPath: "plugin create",
      details: { argument: positionals[1] },
    });
  }

  const directory = positionals[0]!;
  const cwd = options.env.PWD ?? process.cwd();
  const result = await createPluginWorkspace({
    directory,
    cwd,
    signal: options.signal,
  });

  if (!result.ok) {
    const exitCode = exitCodeForError(result.code);
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: result.details,
      exitCode,
      humanStderr: `${result.message}\nerror.code: ${result.code}\n`,
    });
  }

  const payload = {
    workspacePath: result.workspacePath,
    packageName: result.packageName,
    id: result.id,
    files: result.files,
  };

  const human = [
    `Created plugin workspace ${result.packageName}`,
    `  id: ${result.id}`,
    `  path: ${result.workspacePath}`,
    `  files: ${result.files.join(", ")}`,
    "",
  ].join("\n");

  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}
