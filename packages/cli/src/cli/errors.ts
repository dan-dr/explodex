import {
  exitCodeForError,
  failureEnvelope,
  type CliExitCode,
  type CliFailureEnvelope,
  type CliWarning,
  type RenderedCliResult,
} from "../output/envelope.ts";

export type CliFailureInput = {
  operation: string;
  code: string;
  message: string;
  details?: unknown;
  warnings?: CliWarning[];
  humanStderr?: string;
  humanStdout?: string;
  exitCode?: CliExitCode;
};

export function renderFailure(input: CliFailureInput): RenderedCliResult {
  const envelope: CliFailureEnvelope = failureEnvelope(
    input.operation,
    {
      code: input.code,
      message: input.message,
      ...(input.details !== undefined ? { details: input.details } : {}),
    },
    input.warnings ?? [],
  );
  const exitCode = input.exitCode ?? exitCodeForError(input.code);
  const humanStderr =
    input.humanStderr ??
    `${input.message}\nerror.code: ${input.code}\n`;
  return {
    envelope,
    exitCode,
    humanStdout: input.humanStdout ?? "",
    humanStderr,
  };
}

export function usageFailure(options: {
  operation?: string;
  code: string;
  message: string;
  usageLine?: string;
  helpPath?: string;
  details?: unknown;
}): RenderedCliResult {
  const operation = options.operation ?? "cli.parse";
  const lines = [options.message];
  if (options.usageLine !== undefined && options.usageLine.length > 0) {
    lines.push(options.usageLine);
  }
  if (options.helpPath !== undefined && options.helpPath.length > 0) {
    lines.push(`Run 'explodex ${options.helpPath} --help' for details.`);
  } else {
    lines.push("Run 'explodex --help' for details.");
  }
  return renderFailure({
    operation,
    code: options.code,
    message: options.message,
    details: options.details,
    humanStderr: `${lines.join("\n")}\n`,
  });
}
