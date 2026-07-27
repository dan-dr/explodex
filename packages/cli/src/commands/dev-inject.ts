import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { runDevInjectOperation } from "../dev/injection-operation.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";

const OPERATION = "dev.inject";

export async function runDevInject(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const tokens = [...options.rest, ...options.endOfOptions];
  if (tokens.length === 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: "A validated plugin artifact path is required.",
      usageLine: "Usage: explodex dev inject <artifact>",
      helpPath: "dev inject",
    });
  }
  if (tokens.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: tokens[1]!.startsWith("-")
        ? "usage.unknown-option"
        : "usage.invalid-value",
      message: `Unexpected argument or option '${tokens[1]}'.`,
      usageLine: "Usage: explodex dev inject <artifact>",
      helpPath: "dev inject",
    });
  }
  const osHome = options.env.HOME;
  if (osHome === undefined || osHome.length === 0) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: "HOME is required to resolve the isolated development instance.",
    });
  }
  let explodexHome: string;
  try {
    explodexHome = resolveExplodexHome({
      osHome,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    });
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const result = await runDevInjectOperation({
    artifactPath: resolve(options.env.PWD ?? process.cwd(), tokens[0]!),
    osHome,
    explodexHome,
    explicitRoot:
      options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
    timeoutMs: options.globals.timeoutMs,
    signal: options.signal,
  });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: {
        operationId: result.operationId,
        route: result.route,
        ownershipProven: result.ownershipProven,
        compatibilityProven: result.compatibilityProven,
        sourceDelivered: result.sourceDelivered,
        applications: result.applications,
        cause: result.details,
      },
      exitCode: exitCodeForError(result.code),
    });
  }
  return {
    envelope: successEnvelope(OPERATION, result),
    exitCode: 0,
    humanStdout: [
      `Injected ephemeral development artifact ${result.identity.id}@${result.identity.version}.`,
      `route: ${result.route}`,
      `payloadSha256: ${result.identity.payloadSha256}`,
      `ownership: proven ${result.ownership.pid}@${result.ownership.processStartedAt}`,
      `compatibility: proven`,
      `target: ${result.target.targetId} context=${result.target.executionContextId}`,
      "authority: not installed, not enabled, not pending",
      "development process: alive",
      "",
    ].join("\n"),
    humanStderr: "",
  };
}
