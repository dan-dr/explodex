import type { HostAdapters } from "./adapters.ts";
import { evaluateCompatibility, loadCompatibilityRecord } from "./compatibility-state.ts";
import { inspectHost } from "./identity.ts";
import type {
  CompatibilityReport,
  HostInspectionResult,
  ProbeIdentity,
  RunningProcessIdentity,
  SdkRuntimeIdentity,
} from "./types.ts";

export type HostReportOptions = {
  adapters: HostAdapters;
  explodexHome: string;
  sdkRuntime: SdkRuntimeIdentity;
  probe?: ProbeIdentity;
  runningProcess?: RunningProcessIdentity | null;
  signal?: AbortSignal;
};

export type HostReport = HostInspectionResult & {
  explodexHome: string;
  sdkRuntime: SdkRuntimeIdentity;
};

/**
 * Public host inspection + compatibility report for a home.
 * Always resolves the canonical /Applications/ChatGPT.app only (VAL-HOST-001).
 * Read-only with respect to the host bundle; may read (not require) home state.
 */
export async function reportHost(options: HostReportOptions): Promise<HostReport> {
  const inspection = await inspectHost({
    adapters: options.adapters,
    signal: options.signal,
  });

  if (!inspection.ok || inspection.host === null) {
    return {
      ...inspection,
      explodexHome: options.explodexHome,
      sdkRuntime: options.sdkRuntime,
    };
  }

  const persisted = await loadCompatibilityRecord({
    adapters: options.adapters,
    explodexHome: options.explodexHome,
  });

  const compatibility: CompatibilityReport = evaluateCompatibility({
    host: inspection.host,
    sdkRuntime: options.sdkRuntime,
    probe: options.probe,
    persisted,
    runningProcess: options.runningProcess,
  });

  return {
    ...inspection,
    compatibility,
    explodexHome: options.explodexHome,
    sdkRuntime: options.sdkRuntime,
  };
}

/** Format a concise human host report (no secrets). */
export function formatHostReportHuman(report: HostReport): string {
  const lines: string[] = [];
  lines.push("Explodex host inspection");
  lines.push(`home: ${report.explodexHome}`);

  if (!report.ok || report.host === null) {
    lines.push("hostValid: false");
    lines.push(`error.code: ${report.error.code}`);
    lines.push(`error.message: ${report.error.message}`);
    if (report.error.failedPredicates.length > 0) {
      lines.push(`failedPredicates: ${report.error.failedPredicates.join(", ")}`);
    }
    for (const c of report.error.candidates) {
      lines.push(`candidate: ${c.path} (${c.reason})`);
    }
    lines.push(`compatibility.status: ${report.compatibility.status}`);
    return `${lines.join("\n")}\n`;
  }

  const h = report.host;
  lines.push("hostValid: true");
  lines.push(`bundlePath: ${h.bundlePath}`);
  lines.push(`executablePath: ${h.executablePath}`);
  lines.push(`bundleId: ${h.bundleId}`);
  lines.push(`executableName: ${h.executableName}`);
  lines.push(`signingTeam: ${h.signingTeam}`);
  lines.push(`appVersion: ${h.appVersion}`);
  lines.push(`appBuild: ${h.appBuild}`);
  lines.push(`compatibility.status: ${report.compatibility.status}`);
  lines.push(
    `compatibility.allowsDependentWork: ${String(report.compatibility.allowsCompatibilityDependentWork)}`,
  );
  if (report.compatibility.reason) {
    lines.push(`compatibility.reason: ${report.compatibility.reason}`);
  }
  if (report.compatibility.nextAction) {
    lines.push(`compatibility.nextAction: ${report.compatibility.nextAction}`);
  }
  lines.push("readOnly: true");
  return `${lines.join("\n")}\n`;
}

/** Machine-oriented host report object (stable field names, secret-free). */
export function formatHostReportJson(report: HostReport): unknown {
  if (!report.ok || report.host === null) {
    return {
      schemaVersion: 1,
      ok: false,
      operation: "host-inspect",
      error: {
        code: report.error.code,
        message: report.error.message,
        details: {
          failedPredicates: report.error.failedPredicates,
          candidates: report.error.candidates,
        },
      },
      result: {
        hostValid: false,
        compatibility: report.compatibility,
        readOnly: true,
        explodexHome: report.explodexHome,
        sdkRuntime: {
          version: report.sdkRuntime.version,
          sha256: report.sdkRuntime.sha256,
        },
      },
      warnings: [],
    };
  }

  return {
    schemaVersion: 1,
    ok: true,
    operation: "host-inspect",
    result: {
      hostValid: true,
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
      compatibility: report.compatibility,
      readOnly: true,
      explodexHome: report.explodexHome,
      sdkRuntime: {
        version: report.sdkRuntime.version,
        sha256: report.sdkRuntime.sha256,
      },
    },
    warnings: [],
  };
}
