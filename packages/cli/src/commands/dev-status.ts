import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure } from "../cli/errors.ts";
import {
  inspectDevInstanceStatus,
} from "../dev/status-operation.ts";
import type { DevStatusSnapshot } from "../dev/workflow.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { successEnvelope, type RenderedCliResult } from "../output/envelope.ts";

const OPERATION = "dev.status";

function humanStatus(snapshot: DevStatusSnapshot): string {
  const lines = [
    "Explodex development status",
    `root: ${snapshot.rootPath}`,
    `recordedStatus: ${snapshot.assessment.recordedStatus}`,
    `observedStatus: ${snapshot.assessment.observedStatus}`,
    `owned: ${snapshot.assessment.owned}`,
    `compatibilityProven: ${snapshot.assessment.compatibilityProven}`,
    `readOnly: ${snapshot.readOnly}`,
  ];
  if (snapshot.state?.pid !== null && snapshot.state?.pid !== undefined) {
    lines.push(
      `process: ${snapshot.state.pid}@${snapshot.state.processStartedAt ?? "unknown"}`,
    );
  }
  if (snapshot.assessment.selectedTarget !== null) {
    lines.push(
      `target: ${snapshot.assessment.selectedTarget.targetId} context=${snapshot.assessment.selectedTarget.executionContextId}`,
    );
  }
  for (const failure of snapshot.assessment.failures) {
    lines.push(`failure: ${failure.code}: ${failure.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runDevStatus(options: {
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
    explodexHome = resolve(resolveExplodexHome({
      osHome,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    }));
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  try {
    const snapshot = await inspectDevInstanceStatus({
      osHome,
      explodexHome,
      explicitRoot:
        options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
      operation: "status",
      signal: options.signal,
    });
    const invalidRoot = snapshot.state === null
      ? snapshot.assessment.failures.find(
          (failure) => failure.code === "path_alias",
        )
      : undefined;
    if (invalidRoot !== undefined) {
      return renderFailure({
        operation: OPERATION,
        code: "dev.root-invalid",
        message: invalidRoot.message,
        details: {
          rootPath: snapshot.rootPath,
          fallbackUsed: false,
        },
      });
    }
    return {
      envelope: successEnvelope(OPERATION, snapshot),
      exitCode: 0,
      humanStdout: humanStatus(snapshot),
      humanStderr: "",
    };
  } catch (error: unknown) {
    const interrupted = options.signal?.aborted === true;
    return renderFailure({
      operation: OPERATION,
      code: interrupted ? "operation.interrupted" : "dev.status-failed",
      message: interrupted
        ? "Development status was interrupted."
        : error instanceof Error
          ? error.message
          : "Development status failed.",
    });
  }
}
