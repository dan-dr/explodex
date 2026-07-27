import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure } from "../cli/errors.ts";
import {
  runDevLifecycleOperation,
  type DevLifecycleOperationKind,
} from "../dev/lifecycle-operation.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";

export async function runDevLifecycle(options: {
  kind: DevLifecycleOperationKind;
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const operation = `dev.${options.kind}`;
  const osHome = options.env.HOME;
  if (osHome === undefined || osHome.length === 0) {
    return renderFailure({
      operation,
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
      operation,
      code: "config.invalid-environment",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }

  try {
    const result = await runDevLifecycleOperation({
      kind: options.kind,
      osHome,
      explodexHome,
      explicitRoot:
        options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
      timeoutMs: options.globals.timeoutMs,
      signal: options.signal,
    });
    if (!result.ok) {
      return renderFailure({
        operation,
        code: result.code,
        message: result.message,
        details: {
          state: result.state,
          recoveryRequired: result.recoveryRequired,
          partialDisposition: result.partialDisposition,
          cause: result.details,
        },
      });
    }
    const identity = result.state.pid === null
      ? null
      : {
          pid: result.state.pid,
          processStartedAt: result.state.processStartedAt,
          port: result.state.cdpPort,
          targetId: result.state.targetId,
          executionContextId: result.state.executionContextId,
          appVersion: result.state.appVersion,
          appBuild: result.state.appBuild,
        };
    return {
      envelope: successEnvelope(operation, {
        operationId: result.operationId,
        rootPath: result.state.rootPath,
        status: result.state.status,
        reusedReady: result.reusedReady,
        terminationMethod: result.terminationMethod,
        identity,
        state: result.state,
      }),
      exitCode: 0,
      humanStdout: [
        `Explodex development ${options.kind}`,
        `root: ${result.state.rootPath}`,
        `status: ${result.state.status}`,
        `reusedReady: ${result.reusedReady}`,
        `terminationMethod: ${result.terminationMethod ?? "none"}`,
        ...(identity === null
          ? []
          : [
              `process: ${identity.pid}@${identity.processStartedAt}`,
              `target: ${identity.targetId} context=${identity.executionContextId}`,
            ]),
        "",
      ].join("\n"),
      humanStderr: "",
    };
  } catch (error: unknown) {
    const interrupted = options.signal?.aborted === true;
    return renderFailure({
      operation,
      code: interrupted ? "operation.interrupted" : "dev.lifecycle-failed",
      message: interrupted
        ? `Development ${options.kind} was interrupted.`
        : error instanceof Error
          ? error.message
          : `Development ${options.kind} failed.`,
    });
  }
}
