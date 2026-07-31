import { resolve } from "node:path";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { validatePluginSource } from "../plugin/validate.ts";

const OPERATION = "plugin.validate";

export async function runPluginValidate(options: {
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
      usageLine: "Usage: explodex plugin validate [workspace]",
      helpPath: "plugin validate",
      details: { option: unexpected[0] },
    });
  }
  if (positionals.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${positionals[1]}'.`,
      usageLine: "Usage: explodex plugin validate [workspace]",
      helpPath: "plugin validate",
      details: { argument: positionals[1] },
    });
  }

  const cwd = options.env.PWD ?? process.cwd();
  const workspace =
    positionals.length === 1 ? resolve(cwd, positionals[0]!) : resolve(cwd);

  const result = await validatePluginSource({
    workspacePath: workspace,
    timeoutMs: options.globals.timeoutMs,
    env: options.env,
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

  const report = result.report;
  const payload = {
    id: report.id,
    packageName: report.packageName,
    workspacePath: report.workspacePath,
    version: report.version,
    displayName: report.displayName,
    description: report.description,
    entry: report.entry,
    assets: report.assets,
    lifecycle: report.lifecycle,
    sdkRange: report.sdkRange,
    packageManagerVersion: report.packageManagerVersion,
    hotSetupAllowed: report.hotSetupAllowed,
    requiredBoundary: report.requiredBoundary,
    configExecutions: report.configExecutions,
  };

  const human = [
    `Valid plugin source: ${report.packageName}`,
    `  id: ${report.id}`,
    `  version: ${report.version}`,
    `  lifecycle: ${report.lifecycle}`,
    `  sdkRange: ${report.sdkRange}`,
    `  entry: ${report.entry}`,
    `  hotSetupAllowed: ${report.hotSetupAllowed ? "yes" : "no"}`,
    `  requiredBoundary: ${report.requiredBoundary}`,
    "",
  ].join("\n");

  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}
