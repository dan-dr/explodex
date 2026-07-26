import { createDefaultHostAdapters } from "../host/adapters.ts";
import { reportHost, formatHostReportHuman } from "../host/report.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  failureEnvelope,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";

const OPERATION = "host.report";

export async function runHostReport(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
}): Promise<RenderedCliResult> {
  const explodexHome = resolveHome(options.globals, options.env);
  const adapters = await createDefaultHostAdapters();
  const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
  const report = await reportHost({
    adapters,
    explodexHome,
    sdkRuntime: {
      version: sdkRuntime.version,
      sha256: sdkRuntime.sha256,
    },
  });

  if (!report.ok || report.host === null) {
    const code = mapHostFailureCode(report.error.code);
    const result = {
      hostValid: false as const,
      compatibility: sanitizeCompatibility(report.compatibility),
      readOnly: true as const,
      explodexHome: report.explodexHome,
      sdkRuntime: {
        version: report.sdkRuntime.version,
        sha256: report.sdkRuntime.sha256,
      },
    };
    return {
      envelope: failureEnvelope(
        OPERATION,
        {
          code,
          message: report.error.message,
          details: {
            failedPredicates: report.error.failedPredicates,
            candidates: report.error.candidates,
            ...result,
          },
        },
      ),
      exitCode: exitCodeForError(code),
      humanStdout: "",
      humanStderr: formatHostReportHuman(report),
    };
  }

  const result = {
    hostValid: true as const,
    host: {
      bundlePath: report.host.bundlePath,
      executablePath: report.host.executablePath,
      bundleId: report.host.bundleId,
      executableName: report.host.executableName,
      signingTeam: report.host.signingTeam,
      appVersion: report.host.appVersion,
      appBuild: report.host.appBuild,
      hostHashes: report.host.hostHashes,
    },
    compatibility: sanitizeCompatibility(report.compatibility),
    readOnly: true as const,
    explodexHome: report.explodexHome,
    sdkRuntime: {
      version: report.sdkRuntime.version,
      sha256: report.sdkRuntime.sha256,
    },
  };

  return {
    envelope: successEnvelope(OPERATION, result),
    exitCode: EXIT_SUCCESS,
    humanStdout: formatHostReportHuman(report),
    humanStderr: "",
  };
}

function resolveHome(globals: GlobalOptions, env: NodeJS.ProcessEnv): string {
  if (globals.home !== null) return globals.home;
  const fromEnv = env.EXPLODEX_HOME;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const osHome = env.HOME;
  return resolveExplodexHome({ osHome });
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

function sanitizeCompatibility(compatibility: {
  status: string;
  key: unknown;
  allowsCompatibilityDependentWork: boolean;
  reason?: string | null;
  nextAction?: string | null;
}): Record<string, unknown> {
  return {
    status: compatibility.status,
    key: compatibility.key,
    allowsCompatibilityDependentWork: compatibility.allowsCompatibilityDependentWork,
    ...(compatibility.reason !== undefined && compatibility.reason !== null
      ? { reason: compatibility.reason }
      : {}),
    ...(compatibility.nextAction !== undefined && compatibility.nextAction !== null
      ? { nextAction: compatibility.nextAction }
      : {}),
  };
}
