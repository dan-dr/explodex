import { resolve } from "node:path";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { buildPluginWorkspace } from "../plugin/build.ts";

const OPERATION = "plugin.build";

export async function runPluginBuild(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
}): Promise<RenderedCliResult> {
  const positionals = [...options.rest, ...options.endOfOptions];
  const unexpected = positionals.filter((token) => token.startsWith("-"));
  if (unexpected.length > 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.unknown-option",
      message: `Unexpected option '${unexpected[0]}'.`,
      usageLine: "Usage: explodex plugin build [workspace]",
      helpPath: "plugin build",
      details: { option: unexpected[0] },
    });
  }
  if (positionals.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${positionals[1]}'.`,
      usageLine: "Usage: explodex plugin build [workspace]",
      helpPath: "plugin build",
      details: { argument: positionals[1] },
    });
  }

  const cwd = options.env.PWD ?? process.cwd();
  const workspace =
    positionals.length === 1 ? resolve(cwd, positionals[0]!) : resolve(cwd);

  const result = await buildPluginWorkspace({
    workspacePath: workspace,
    timeoutMs: options.globals.timeoutMs,
    env: options.env,
  });

  if (!result.ok) {
    const details = {
      ...(result.details ?? {}),
      priorDistFingerprint: result.priorDistFingerprint,
      distFingerprintAfter: result.distFingerprintAfter,
      diagnostics: result.diagnostics,
    };
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details,
      exitCode: exitCodeForError(result.code),
      humanStderr: `${result.message}\nerror.code: ${result.code}\n`,
    });
  }

  const payload = {
    id: result.report.id,
    packageName: result.report.packageName,
    workspacePath: result.report.workspacePath,
    version: result.report.version,
    lifecycle: result.report.lifecycle,
    sdkRange: result.report.sdkRange,
    entry: result.entry,
    map: result.map,
    distPath: result.distPath,
    jsBytes: result.jsBytes,
    jsSha256: result.jsSha256,
  };

  const human = [
    `Built plugin: ${result.report.packageName}`,
    `  id: ${result.report.id}`,
    `  version: ${result.report.version}`,
    `  entry: dist/${result.entry}`,
    `  map: dist/${result.map}`,
    `  jsBytes: ${result.jsBytes}`,
    `  jsSha256: ${result.jsSha256}`,
    "",
  ].join("\n");

  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}
