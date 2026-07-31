import { resolve } from "node:path";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { validateStandaloneArtifact } from "../plugin/artifact-validate.ts";

const OPERATION = "plugin.artifact.validate";

export async function runPluginArtifactValidate(options: {
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
      usageLine: "Usage: explodex plugin artifact validate <path>",
      helpPath: "plugin artifact validate",
      details: { option: unexpected[0] },
    });
  }
  if (positionals.length === 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: "A path to a packaged artifact or dist payload is required.",
      usageLine: "Usage: explodex plugin artifact validate <path>",
      helpPath: "plugin artifact validate",
    });
  }
  if (positionals.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${positionals[1]}'.`,
      usageLine: "Usage: explodex plugin artifact validate <path>",
      helpPath: "plugin artifact validate",
      details: { argument: positionals[1] },
    });
  }

  const cwd = options.env.PWD ?? process.cwd();
  const artifactPath = resolve(cwd, positionals[0]!);

  const result = await validateStandaloneArtifact(artifactPath, {
    signal: options.signal,
  });
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

  const payload = {
    id: result.id,
    version: result.version,
    displayName: result.displayName,
    description: result.description,
    lifecycle: result.lifecycle,
    sdkRange: result.sdkRange,
    payloadSha256: result.payloadSha256,
    archiveSha256: result.archiveSha256,
    archiveRootName: result.archiveRootName,
    files: result.files,
    registrationCount: result.registrationCount,
    source: result.source,
  };

  const digestLines = [
    `  payloadSha256: ${result.payloadSha256}`,
    result.archiveSha256 === null
      ? "  archiveSha256: (not an archive input)"
      : `  archiveSha256: ${result.archiveSha256}`,
  ];

  const human = [
    `Valid standalone artifact: ${result.id}@${result.version}`,
    `  lifecycle: ${result.lifecycle}`,
    `  sdkRange: ${result.sdkRange}`,
    ...digestLines,
    `  source: ${result.source}`,
    `  files: ${result.files.length}`,
    "",
  ].join("\n");

  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}
