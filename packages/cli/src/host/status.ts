import { isAbsolute } from "node:path";
import type { ProcessIdentity } from "../runtime/adapters.ts";
import type {
  CdpTargetSummary,
  EndpointInspectionResult,
  TargetIdentity,
} from "../cdp/types.ts";
import {
  CANONICAL_BUNDLE_PATH,
  CANONICAL_EXECUTABLE_NAME,
  DECLARED_ROLE_ENDPOINTS,
} from "./constants.ts";

export type HostRole = "main" | "development";
export type DeclaredPort = 9333 | 9444;
export type LoopbackHost = "127.0.0.1";

export type DeclaredRoleEndpoint = {
  host: LoopbackHost;
  port: DeclaredPort;
};

export type ProcessObservation = {
  pid: number;
  parentPid: number;
  executablePath: string;
  arguments: string[];
};

export type VerifiedProcess = ProcessObservation & {
  processStartedAt: string;
};

export type ListenerObservation = {
  pid: number;
  processStartedAt: string | null;
  host: string;
  port: number;
  family: "ipv4" | "ipv6" | "unknown";
};

export type ProcessInventoryAdapter = {
  list(options?: { signal?: AbortSignal }): Promise<ProcessObservation[]>;
  identify(pid: number, options?: { signal?: AbortSignal }): Promise<ProcessIdentity | null>;
};

export type PortInventoryAdapter = {
  listenersFor(port: DeclaredPort, options?: { signal?: AbortSignal }): Promise<ListenerObservation[]>;
};

export type HostStatusAdapters = {
  process: ProcessInventoryAdapter;
  port: PortInventoryAdapter;
};

export type MainClassification = "no-main" | "plain-main" | "cdp-main" | "ambiguous-main";
export type EndpointObstruction =
  | "port-free"
  | "matching-endpoint"
  | "foreign-or-mismatched-endpoint";

export type HostStatusDiagnosticCode =
  | "no_main"
  | "plain_main"
  | "cdp_main"
  | "process_ambiguous"
  | "process_identity_unresolved"
  | "renderer_not_found"
  | "renderer_ambiguous"
  | "context_not_found"
  | "context_ambiguous"
  | "endpoint_identity_mismatch";

export type HostStatusDiagnostic = {
  code: HostStatusDiagnosticCode;
  message: string;
  details?: unknown;
};

export type HostStatusResult = {
  role: HostRole;
  endpoint: DeclaredRoleEndpoint;
  mainState: MainClassification;
  endpointObstruction: EndpointObstruction;
  processes: VerifiedProcess[];
  listeners: ListenerObservation[];
  selectedTarget: TargetIdentity | null;
  targetInventory: CdpTargetSummary[];
  diagnostic: HostStatusDiagnostic;
  readOnly: true;
  activity: {
    launched: false;
    evaluated: false;
    wroteState: false;
    focused: false;
  };
};

export type CdpAvailabilityInspector = {
  inspect(input: {
    role: HostRole;
    endpoint: DeclaredRoleEndpoint;
    process: VerifiedProcess;
    adapters: HostStatusAdapters;
    signal?: AbortSignal;
  }): Promise<EndpointInspectionResult>;
};

const CANONICAL_EXECUTABLE_PATH =
  `${CANONICAL_BUNDLE_PATH}/Contents/MacOS/${CANONICAL_EXECUTABLE_NAME}`;

export function roleEndpoint(role: HostRole): DeclaredRoleEndpoint {
  const endpoint = DECLARED_ROLE_ENDPOINTS[role];
  return { ...endpoint };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function normalizeProcessObservation(value: ProcessObservation): ProcessObservation | null {
  if (!isPositiveInteger(value.pid) || !Number.isInteger(value.parentPid) || value.parentPid < 0) {
    return null;
  }
  if (!isAbsolute(value.executablePath) || !Array.isArray(value.arguments)) return null;
  if (value.arguments.some((argument) => typeof argument !== "string")) return null;
  return {
    pid: value.pid,
    parentPid: value.parentPid,
    executablePath: value.executablePath,
    arguments: [...value.arguments],
  };
}

function isPlausibleMain(process: ProcessObservation): boolean {
  return process.executablePath === CANONICAL_EXECUTABLE_PATH;
}

function sortProcesses(processes: VerifiedProcess[]): VerifiedProcess[] {
  return [...processes].sort((left, right) => left.pid - right.pid);
}

function sortListeners(listeners: ListenerObservation[]): ListenerObservation[] {
  return [...listeners].sort((left, right) => {
    if (left.port !== right.port) return left.port - right.port;
    if (left.pid !== right.pid) return left.pid - right.pid;
    return left.host.localeCompare(right.host);
  });
}

function activity(): HostStatusResult["activity"] {
  return { launched: false, evaluated: false, wroteState: false, focused: false };
}

function statusBase(input: {
  role: HostRole;
  endpoint: DeclaredRoleEndpoint;
  processes: VerifiedProcess[];
  listeners: ListenerObservation[];
  endpointObstruction: EndpointObstruction;
  mainState: MainClassification;
  diagnostic: HostStatusDiagnostic;
  selectedTarget?: TargetIdentity | null;
  targetInventory?: CdpTargetSummary[];
}): HostStatusResult {
  return {
    role: input.role,
    endpoint: input.endpoint,
    mainState: input.mainState,
    endpointObstruction: input.endpointObstruction,
    processes: sortProcesses(input.processes),
    listeners: sortListeners(input.listeners),
    selectedTarget: input.selectedTarget ?? null,
    targetInventory: [...(input.targetInventory ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostic: input.diagnostic,
    readOnly: true,
    activity: activity(),
  };
}

function listenerMatchesProcess(
  listener: ListenerObservation,
  process: VerifiedProcess,
  endpoint: DeclaredRoleEndpoint,
): boolean {
  return listener.pid === process.pid &&
    listener.processStartedAt === process.processStartedAt &&
    listener.host === endpoint.host &&
    listener.port === endpoint.port;
}

function statusFromEndpointInspection(input: {
  role: HostRole;
  endpoint: DeclaredRoleEndpoint;
  process: VerifiedProcess;
  listeners: ListenerObservation[];
  inspection: EndpointInspectionResult;
}): HostStatusResult {
  if (input.inspection.kind === "available") {
    return statusBase({
      role: input.role,
      endpoint: input.endpoint,
      processes: [input.process],
      listeners: input.listeners,
      endpointObstruction: "matching-endpoint",
      mainState: "cdp-main",
      diagnostic: { code: "cdp_main", message: "One exact process, endpoint, page, and context matched." },
      selectedTarget: input.inspection.target,
      targetInventory: input.inspection.targets,
    });
  }

  const diagnostic: HostStatusDiagnostic = input.inspection.kind === "identity-mismatch"
    ? {
        code: "endpoint_identity_mismatch",
        message: "The endpoint identity did not match the requested process and role.",
        details: input.inspection.details,
      }
    : input.inspection.code === "target_ambiguous"
      ? {
          code: "renderer_ambiguous",
          message: "The matching endpoint exposed multiple compatible renderers.",
          details: input.inspection.details,
        }
      : input.inspection.code === "context_ambiguous"
        ? {
            code: "context_ambiguous",
            message: "The exact renderer exposed multiple default execution contexts.",
            details: input.inspection.details,
          }
        : input.inspection.code === "context_not_found"
          ? {
              code: "context_not_found",
              message: "The exact renderer exposed no default execution context.",
              details: input.inspection.details,
            }
          : {
              code: "renderer_not_found",
              message: "The matching endpoint exposed no exact compatible renderer.",
              details: input.inspection.details,
            };

  return statusBase({
    role: input.role,
    endpoint: input.endpoint,
    processes: [input.process],
    listeners: input.listeners,
    endpointObstruction: input.inspection.kind === "identity-mismatch"
      ? "foreign-or-mismatched-endpoint"
      : "matching-endpoint",
    mainState: "ambiguous-main",
    diagnostic,
    targetInventory: input.inspection.targets,
  });
}

/**
 * Read-only process/declared-port inventory. It never launches, focuses, evaluates,
 * writes healthy state, scans undeclared ports, or queries a foreign listener.
 */
export async function collectHostStatus(options: {
  role: HostRole;
  adapters: HostStatusAdapters;
  inspectCdp?: CdpAvailabilityInspector;
  signal?: AbortSignal;
}): Promise<HostStatusResult> {
  const endpoint = roleEndpoint(options.role);
  const [rawProcesses, rawListeners] = await Promise.all([
    options.adapters.process.list({ signal: options.signal }),
    options.adapters.port.listenersFor(endpoint.port, { signal: options.signal }),
  ]);

  const plausible = rawProcesses
    .map(normalizeProcessObservation)
    .filter((candidate): candidate is ProcessObservation => candidate !== null)
    .filter(isPlausibleMain);
  const listeners: ListenerObservation[] = [];
  for (const candidate of rawListeners) {
    if (!isPositiveInteger(candidate.pid) || !Number.isInteger(candidate.port) || candidate.port <= 0) continue;
    const identity = await options.adapters.process.identify(candidate.pid, { signal: options.signal });
    listeners.push({
      ...candidate,
      processStartedAt: identity?.pid === candidate.pid ? identity.processStartedAt : null,
    });
  }
  const verified: VerifiedProcess[] = [];
  let unresolvedIdentity = false;
  for (const candidate of plausible) {
    const identity = await options.adapters.process.identify(candidate.pid, { signal: options.signal });
    if (identity === null || identity.pid !== candidate.pid || identity.processStartedAt.length === 0) {
      unresolvedIdentity = true;
      continue;
    }
    verified.push({ ...candidate, processStartedAt: identity.processStartedAt });
  }

  const endpointObstruction: EndpointObstruction = listeners.length === 0
    ? "port-free"
    : "foreign-or-mismatched-endpoint";

  if (plausible.length === 0) {
    return statusBase({
      role: options.role,
      endpoint,
      processes: [],
      listeners,
      endpointObstruction,
      mainState: "no-main",
      diagnostic: { code: "no_main", message: "No plausible canonical ChatGPT main process was observed." },
    });
  }

  if (unresolvedIdentity || verified.length !== plausible.length || verified.length > 1) {
    return statusBase({
      role: options.role,
      endpoint,
      processes: verified,
      listeners,
      endpointObstruction,
      mainState: "ambiguous-main",
      diagnostic: unresolvedIdentity
        ? { code: "process_identity_unresolved", message: "At least one plausible process lacked an exact start identity." }
        : { code: "process_ambiguous", message: "More than one plausible canonical ChatGPT main process was observed." },
    });
  }

  const selectedProcess = verified[0];
  if (selectedProcess === undefined) {
    throw new Error("Verified process inventory was unexpectedly empty");
  }
  const matchingListeners = listeners.filter((candidate) =>
    listenerMatchesProcess(candidate, selectedProcess, endpoint),
  );
  if (matchingListeners.length !== 1 || listeners.length !== 1 || options.inspectCdp === undefined) {
    return statusBase({
      role: options.role,
      endpoint,
      processes: [selectedProcess],
      listeners,
      endpointObstruction: matchingListeners.length === 1 && listeners.length === 1
        ? "matching-endpoint"
        : endpointObstruction,
      mainState: "plain-main",
      diagnostic: { code: "plain_main", message: "One canonical main process exists without a verified exact renderer." },
    });
  }

  const currentIdentity = await options.adapters.process.identify(selectedProcess.pid, { signal: options.signal });
  if (
    currentIdentity === null ||
    currentIdentity.pid !== selectedProcess.pid ||
    currentIdentity.processStartedAt !== selectedProcess.processStartedAt
  ) {
    return statusBase({
      role: options.role,
      endpoint,
      processes: [selectedProcess],
      listeners,
      endpointObstruction: "foreign-or-mismatched-endpoint",
      mainState: "ambiguous-main",
      diagnostic: {
        code: "process_identity_unresolved",
        message: "The endpoint owner process identity changed before endpoint access.",
      },
    });
  }
  const rawCurrentListeners = await options.adapters.port.listenersFor(endpoint.port, { signal: options.signal });
  const currentListeners: ListenerObservation[] = [];
  for (const candidate of rawCurrentListeners) {
    const identity = await options.adapters.process.identify(candidate.pid, { signal: options.signal });
    currentListeners.push({
      ...candidate,
      processStartedAt: identity?.pid === candidate.pid ? identity.processStartedAt : null,
    });
  }
  const currentMatching = currentListeners.filter((candidate) =>
    listenerMatchesProcess(candidate, selectedProcess, endpoint),
  );
  if (currentListeners.length !== 1 || currentMatching.length !== 1) {
    return statusBase({
      role: options.role,
      endpoint,
      processes: [selectedProcess],
      listeners: currentListeners,
      endpointObstruction: currentListeners.length === 0 ? "port-free" : "foreign-or-mismatched-endpoint",
      mainState: "plain-main",
      diagnostic: {
        code: "plain_main",
        message: "Declared port ownership changed before endpoint access.",
      },
    });
  }

  const inspection = await options.inspectCdp.inspect({
    role: options.role,
    endpoint,
    process: selectedProcess,
    adapters: options.adapters,
    signal: options.signal,
  });
  return statusFromEndpointInspection({
    role: options.role,
    endpoint,
    process: selectedProcess,
    listeners,
    inspection,
  });
}

export function formatHostStatusHuman(status: HostStatusResult): string {
  const lines = [
    "Explodex host status",
    `role: ${status.role}`,
    `endpoint: ${status.endpoint.host}:${status.endpoint.port}`,
    `mainState: ${status.mainState}`,
    `endpointObstruction: ${status.endpointObstruction}`,
    `diagnostic.code: ${status.diagnostic.code}`,
  ];
  for (const process of status.processes) {
    lines.push(`process: ${process.pid}@${process.processStartedAt} ${process.executablePath}`);
  }
  if (status.selectedTarget !== null) {
    lines.push(
      `target: ${status.selectedTarget.targetId} context=${status.selectedTarget.executionContextId}`,
    );
  }
  lines.push("readOnly: true");
  return `${lines.join("\n")}\n`;
}

export function formatHostStatusJson(status: HostStatusResult): unknown {
  return {
    schemaVersion: 1,
    ok: true,
    operation: "status",
    result: status,
    warnings: [],
  };
}
