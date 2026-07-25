import type { HostRole, DeclaredPort } from "../host/status.ts";

export type CdpEndpointVersion = {
  browser: string;
  protocolVersion: string;
  webSocketDebuggerUrl: string;
  /** Optional endpoint-published PID. When present it must match ownership evidence. */
  pid?: number;
};

export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
};

export type CdpTargetSummary = {
  id: string;
  type: string;
  url: string;
  title?: string;
};

export type CdpExecutionContext = {
  id: number;
  uniqueId: string;
  targetId: string;
  frameId: string;
  isDefault: boolean;
  origin: string;
  name: string;
};

export type TargetIdentity = {
  role: HostRole;
  pid: number;
  processStartedAt: string;
  executablePath: string;
  appVersion: string;
  appBuild: string;
  port: DeclaredPort;
  browserIdentity: string;
  targetId: string;
  targetType: "page";
  targetUrl: "app://-/index.html";
  executionContextId: number;
  executionContextUniqueId: string;
  frameId: string;
};

export type EndpointInspectionResult =
  | {
      kind: "available";
      target: TargetIdentity;
      targets: CdpTargetSummary[];
    }
  | {
      kind: "rejected";
      code: TargetSelectionRejectionCode;
      browserIdentity?: string;
      targets: CdpTargetSummary[];
      details: unknown;
    }
  | {
      kind: "identity-mismatch";
      browserIdentity?: string;
      targets: CdpTargetSummary[];
      details?: unknown;
    };

export type TargetSelectionRejectionCode =
  | "target_not_found"
  | "target_ambiguous"
  | "context_not_found"
  | "context_ambiguous";

export type TargetSelectionResult =
  | {
      kind: "selected";
      target: CdpTarget;
      context: CdpExecutionContext;
      ignoredTargetIds: string[];
    }
  | {
      kind: "rejected";
      code: TargetSelectionRejectionCode;
      message: string;
      candidates: CdpTargetSummary[];
    };

export type TargetingErrorCode =
  | TargetSelectionRejectionCode
  | "endpoint_identity_mismatch"
  | "host_identity_drift"
  | "process_identity_drift"
  | "port_owner_drift"
  | "browser_identity_drift"
  | "target_identity_drift"
  | "context_identity_drift";
