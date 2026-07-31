import { createDefaultHostAdapters } from "../host/adapters.ts";
import { evaluateCompatibility, loadCompatibilityRecord } from "../host/compatibility-state.ts";
import { inspectHost } from "../host/identity.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure } from "../cli/errors.ts";

const OPERATION = "compatibility.status";

export async function runCompatibilityStatus(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const explodexHome = resolveHome(options.globals, options.env);
  const adapters = await createDefaultHostAdapters();
  const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
  const inspection = await inspectHost({ adapters, signal: options.signal });

  if (!inspection.ok || inspection.host === null) {
    return renderFailure({
      operation: OPERATION,
      code: mapHostFailureCode(inspection.error.code),
      message: inspection.error.message,
      details: {
        failedPredicates: inspection.error.failedPredicates,
        candidates: inspection.error.candidates,
        explodexHome,
      },
      humanStderr: [
        "Explodex compatibility status",
        `home: ${explodexHome}`,
        "hostValid: false",
        `error.code: ${inspection.error.code}`,
        `error.message: ${inspection.error.message}`,
        "compatibility.status: unproven",
        "nextAction: fix host identity, then run explodex compatibility probe",
      ].join("\n") + "\n",
    });
  }

  const persisted = await loadCompatibilityRecord({ adapters, explodexHome });
  const compatibility = evaluateCompatibility({
    host: inspection.host,
    sdkRuntime: {
      version: sdkRuntime.version,
      sha256: sdkRuntime.sha256,
    },
    persisted,
    runningProcess: null,
  });

  const result = {
    host: {
      bundlePath: inspection.host.bundlePath,
      appVersion: inspection.host.appVersion,
      appBuild: inspection.host.appBuild,
      signingTeam: inspection.host.signingTeam,
    },
    sdkRuntime: {
      version: sdkRuntime.version,
      sha256: sdkRuntime.sha256,
    },
    compatibility: {
      status: compatibility.status,
      key: compatibility.key,
      allowsCompatibilityDependentWork: compatibility.allowsCompatibilityDependentWork,
      ...(compatibility.reason !== undefined && compatibility.reason !== null
        ? { reason: compatibility.reason }
        : {}),
      ...(compatibility.nextAction !== undefined && compatibility.nextAction !== null
        ? { nextAction: compatibility.nextAction }
        : {}),
    },
    explodexHome,
    readOnly: true as const,
  };

  const human = [
    "Explodex compatibility status",
    `home: ${explodexHome}`,
    `host.appVersion: ${inspection.host.appVersion}`,
    `host.appBuild: ${inspection.host.appBuild}`,
    `sdkRuntime.version: ${sdkRuntime.version}`,
    `sdkRuntime.sha256: ${sdkRuntime.sha256}`,
    `compatibility.status: ${compatibility.status}`,
    `compatibility.allowsDependentWork: ${String(compatibility.allowsCompatibilityDependentWork)}`,
    ...(compatibility.reason !== undefined && compatibility.reason !== null
      ? [`compatibility.reason: ${compatibility.reason}`]
      : []),
    ...(compatibility.nextAction !== undefined && compatibility.nextAction !== null
      ? [`compatibility.nextAction: ${compatibility.nextAction}`]
      : []),
    "readOnly: true",
  ].join("\n") + "\n";

  // Unproven is a successful read-only status report, not a blocked mutation.
  return {
    envelope: successEnvelope(OPERATION, result),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}

function resolveHome(globals: GlobalOptions, env: NodeJS.ProcessEnv): string {
  if (globals.home !== null) return globals.home;
  const fromEnv = env.EXPLODEX_HOME;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return resolveExplodexHome({ osHome: env.HOME });
}

function mapHostFailureCode(code: string): string {
  switch (code) {
    case "host_missing":
      return "host.not-found";
    case "host_unresolved_candidates":
      return "host.ambiguous";
    default:
      return "host.invalid";
  }
}
