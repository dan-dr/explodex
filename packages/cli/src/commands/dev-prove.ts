import { join } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure } from "../cli/errors.ts";
import { runPhase0LaunchIsolation } from "../dev/phase0-operation.ts";
import {
  canonicalizeDevRootSelection,
  canonicalizePathForCreation,
  resolveDevRootSelection,
  validateDevRootSelection,
} from "../dev/root-selection.ts";
import { loadDevInstanceStateResult } from "../dev/state.ts";
import { createDefaultHostAdapters } from "../host/adapters.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { successEnvelope, type RenderedCliResult } from "../output/envelope.ts";

const OPERATION = "dev.prove";

export function devProveCommandForRoot(
  selection: { explicit: boolean; rootPath: string },
  command: "prove" | "ensure",
): string {
  const root = selection.explicit
    ? ` --dev-root ${JSON.stringify(selection.rootPath)}`
    : "";
  return command === "prove"
    ? `explodex --timeout 10m${root} dev prove`
    : `explodex${root} dev ensure`;
}

export async function runDevProve(options: {
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

  try {
    const explodexHome = resolveExplodexHome({
      osHome,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    });
    const adapters = await createDefaultHostAdapters();
    const selection = await canonicalizeDevRootSelection({
      fs: adapters.fs,
      selection: resolveDevRootSelection({
        osHome,
        explodexHome,
        explicitRoot: options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null,
      }),
    });
    const existingState = await loadDevInstanceStateResult({
      adapters,
      statePath: selection.layout.statePath,
    });
    const [chatGptProfile, codexProfile, userCodexHome] = await Promise.all([
      canonicalizePathForCreation(
        adapters.fs,
        join(osHome, "Library", "Application Support", "ChatGPT"),
      ),
      canonicalizePathForCreation(
        adapters.fs,
        join(osHome, "Library", "Application Support", "Codex"),
      ),
      canonicalizePathForCreation(adapters.fs, join(osHome, ".codex")),
    ]);
    const rootValidation = await validateDevRootSelection({
      fs: adapters.fs,
      selection,
      existingState: existingState.state,
      stateLoadStatus: existingState.status,
      protectedPaths: {
        mainProfilePaths: [chatGptProfile.path, codexProfile.path],
        userCodexHome: userCodexHome.path,
        explodexHome,
      },
    });
    if (!rootValidation.ok) {
      return renderFailure({
        operation: OPERATION,
        code: "dev.root-invalid",
        message: rootValidation.message,
        details: {
          rootCode: rootValidation.code,
          rootPath: rootValidation.requestedRoot,
          fallbackUsed: false,
        },
      });
    }
    const result = await runPhase0LaunchIsolation({
      adapters,
      osHome,
      rootPath: selection.rootPath,
      protectedPaths: {
        mainProfilePath: join(osHome, "Library", "Application Support", "Codex"),
        userCodexHome: join(osHome, ".codex"),
        explodexHome,
      },
      readinessTimeoutMs: Math.min(options.globals.timeoutMs, 45_000),
      stopTimeoutMs: Math.min(options.globals.timeoutMs, 15_000),
      lockWaitMs: Math.min(options.globals.timeoutMs, 5_000),
      keepProcessAlive: false,
      signal: options.signal,
    });

    if (options.signal?.aborted === true) {
      return renderFailure({
        operation: OPERATION,
        code: "operation.interrupted",
        message: "Development proof was interrupted.",
      });
    }
    if (!result.ok) {
      return renderFailure({
        operation: OPERATION,
        code: "dev.proof-failed",
        message: result.error.message,
        details: {
          cause: result.error.code,
          rootPath: result.layout?.rootPath ?? selection.rootPath,
          status: result.contract.status,
          protectedMainSurvived: result.protectedMainSurvived,
          nextAction: `Inspect the proof failure, then rerun '${devProveCommandForRoot(selection, "prove")}'.`,
        },
      });
    }

    const summary = {
      rootPath: result.layout?.rootPath ?? selection.rootPath,
      status: result.contract.status,
      provenAt: result.contract.provenAt,
      appVersion: result.frozenHost?.appVersion ?? null,
      appBuild: result.frozenHost?.appBuild ?? null,
      retainedKnobs: result.contract.retainedKnobs,
      experimentCount: result.contract.comparativeExperiments.length,
      protectedMainSurvived: result.protectedMainSurvived,
      lifecycleMutationAllowed: result.allowsLifecycleMutation,
      acceptanceProcessStopped: result.contract.acceptanceAuthority?.mode === "stopped",
      nextAction: devProveCommandForRoot(selection, "ensure"),
    };
    return {
      envelope: successEnvelope(OPERATION, summary),
      exitCode: 0,
      humanStdout: [
        "Explodex development proof",
        `root: ${summary.rootPath}`,
        `status: ${summary.status}`,
        `host: ${summary.appVersion ?? "unknown"} (${summary.appBuild ?? "unknown"})`,
        `experiments: ${summary.experimentCount}`,
        `protectedMainSurvived: ${summary.protectedMainSurvived}`,
        `nextAction: ${summary.nextAction}`,
        "",
      ].join("\n"),
      humanStderr: "",
    };
  } catch (error: unknown) {
    const interrupted = options.signal?.aborted === true;
    return renderFailure({
      operation: OPERATION,
      code: interrupted ? "operation.interrupted" : "dev.proof-failed",
      message: interrupted
        ? "Development proof was interrupted."
        : error instanceof Error
          ? error.message
          : "Development proof failed.",
    });
  }
}
