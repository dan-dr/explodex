import { resolve } from "node:path";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { packagePluginWorkspace } from "../plugin/package.ts";

const OPERATION = "plugin.package";

function takeOption(
  tokens: string[],
  name: string,
): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === name) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("-")) {
        return { value: null, rest: tokens };
      }
      value = next;
      index += 1;
      continue;
    }
    if (token.startsWith(`${name}=`)) {
      value = token.slice(name.length + 1);
      continue;
    }
    rest.push(token);
  }
  return { value, rest };
}

export async function runPluginPackage(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
}): Promise<RenderedCliResult> {
  const combined = [...options.rest, ...options.endOfOptions];
  const { value: outputOption, rest: afterOutput } = takeOption(combined, "--output");
  const unexpected = afterOutput.filter((token) => token.startsWith("-"));
  if (unexpected.length > 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.unknown-option",
      message: `Unexpected option '${unexpected[0]}'.`,
      usageLine: "Usage: explodex plugin package [workspace] [--output <directory>]",
      helpPath: "plugin package",
      details: { option: unexpected[0] },
    });
  }
  if (afterOutput.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${afterOutput[1]}'.`,
      usageLine: "Usage: explodex plugin package [workspace] [--output <directory>]",
      helpPath: "plugin package",
      details: { argument: afterOutput[1] },
    });
  }

  const cwd = options.env.PWD ?? process.cwd();
  const workspace =
    afterOutput.length === 1 ? resolve(cwd, afterOutput[0]!) : resolve(cwd);
  const outputDir = resolve(cwd, outputOption ?? ".");

  const result = await packagePluginWorkspace({
    workspacePath: workspace,
    outputDir,
    timeoutMs: options.globals.timeoutMs,
    env: options.env,
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
    id: result.report.id,
    packageName: result.report.packageName,
    workspacePath: result.report.workspacePath,
    version: result.report.version,
    payloadSha256: result.payloadSha256,
    archiveSha256: result.archiveSha256,
    archiveRootName: result.archiveRootName,
    archiveFileName: result.archiveFileName,
    generationId: result.generationId,
    outputPath: result.outputPath,
    files: result.files,
  };

  const human = [
    `Packaged plugin: ${result.report.packageName}`,
    `  id: ${result.report.id}`,
    `  version: ${result.report.version}`,
    `  payloadSha256: ${result.payloadSha256}`,
    `  archiveSha256: ${result.archiveSha256}`,
    `  archiveRootName: ${result.archiveRootName}`,
    `  generationId: ${result.generationId}`,
    `  output: ${result.outputPath}`,
    "",
  ].join("\n");

  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}
