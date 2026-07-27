import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure } from "../cli/errors.ts";
import { inspectDevInstanceStatus } from "../dev/status-operation.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { successEnvelope, type RenderedCliResult } from "../output/envelope.ts";

const OPERATION = "dev.focus";

export async function runDevFocus(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
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
  const snapshot = await inspectDevInstanceStatus({
    osHome,
    explodexHome,
    explicitRoot:
      options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
    operation: "focus",
    signal: options.signal,
  });
  if (
    !snapshot.assessment.owned ||
    !snapshot.assessment.mutationAllowed ||
    snapshot.state?.pid === null ||
    snapshot.state?.pid === undefined
  ) {
    return renderFailure({
      operation: OPERATION,
      code: "dev.ownership-uncertain",
      message:
        snapshot.assessment.failures[0]?.message ??
        "Exact development ownership was not proven for focus.",
      details: {
        rootPath: snapshot.rootPath,
        failures: snapshot.assessment.failures,
        focused: false,
        authorityGranted: false,
      },
    });
  }
  const result = {
    status: "unsupported" as const,
    rootPath: snapshot.rootPath,
    pid: snapshot.state.pid,
    processStartedAt: snapshot.state.processStartedAt,
    focused: false,
    authorityGranted: false,
    reason:
      "No build-proven process-specific macOS activation method is available; bundle-level activation was not attempted.",
  };
  return {
    envelope: successEnvelope(OPERATION, result),
    exitCode: 0,
    humanStdout: [
      "Development focus is unsupported on this host.",
      result.reason,
      "No mutation authority was granted.",
      "",
    ].join("\n"),
    humanStderr: "",
  };
}
