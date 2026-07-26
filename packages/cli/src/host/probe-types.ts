import type { CompatibilityKey, HostIdentity, ProbeIdentity, SdkRuntimeIdentity } from "./types.ts";
import type { Phase0FrozenHost, Phase0LaunchContract } from "../dev/types.ts";

/**
 * Probe result schema. Bumping invalidates prior persisted proofs via key.probeSchemaVersion.
 * v2: unique inventories + validated successful invoked bridge transport evidence.
 */
export const COMPATIBILITY_PROBE_RESULT_SCHEMA_VERSION = 2 as const;

/** Exact-renderer bridge transports that may authorize a benign probe request. */
export const ALLOWED_BRIDGE_TRANSPORTS = [
  "appServerSend",
  "electronBridge.sendMessageFromView",
] as const;

export type AllowedBridgeTransport = (typeof ALLOWED_BRIDGE_TRANSPORTS)[number];

/** Required bridge method names that must appear on the exact-current host surface. */
export const REQUIRED_BRIDGE_METHODS = [
  "start-turn-for-host",
  "update-thread-settings-for-next-turn",
] as const;

export type RequiredBridgeMethod = (typeof REQUIRED_BRIDGE_METHODS)[number];

/**
 * Required UI anchors from VAL-HOST-039.
 * Signed-in-only anchors may remain pending-unreachable rather than fail.
 */
export const REQUIRED_PROBE_ANCHORS = [
  "sidebar",
  "profileSettingsFooter",
  "threadFooter",
  "aboveComposer",
  "composerInput",
  "browserSidebarBanner",
  "homeAmbient",
] as const;

export type ProbeAnchorName = (typeof REQUIRED_PROBE_ANCHORS)[number];

export type AnchorVerdict = "pass" | "optional" | "pending-unreachable" | "fail";

export type ProbeOutcome = "proven" | "pending" | "unproven" | "failed";

/** Exact identity fields every probe section must share before atomic commit. */
export type ProbeCorrelationIdentity = {
  operationId: string;
  compatibilityKey: CompatibilityKey;
  frozenHost: HostIdentity;
  pid: number;
  processStartedAt: string;
  port: 9444;
  targetId: string;
  executionContextId: number;
  executionContextUniqueId: string;
  sdkRuntime: SdkRuntimeIdentity;
  probe: ProbeIdentity;
};

export type ProbeIsolationSection = {
  complete: boolean;
  phase0Status: Phase0LaunchContract["status"] | null;
  retainedKnobs: string[];
  launchMarker: string | null;
  isolation: Phase0LaunchContract["isolation"] | null;
  phase0FrozenHost: Phase0FrozenHost | null;
  reason: string | null;
};

export type ProbeEndpointSection = {
  complete: boolean;
  portOwnerPid: number | null;
  browserIdentity: string | null;
  endpointPublishedPid: number | null;
  targets: Array<{ id: string; type: string; url: string; title?: string }>;
  selectedTargetId: string | null;
  selectedTargetUrl: "app://-/index.html" | null;
  executionContextId: number | null;
  executionContextUniqueId: string | null;
  reason: string | null;
};

export type ProbeConversationSurface = {
  href: string | null;
  readyState: string | null;
  conversationIds: string[];
  messageCount: number | null;
  composerValue: string | null;
  nextTurnHints: Array<{ key: string; value: string }>;
};

export type ProbeBridgeSection = {
  complete: boolean;
  transportAvailable: boolean;
  /**
   * Exact bridge transport that was actually invoked for the benign request.
   * Availability-only checks never set this; wrong transports remain incomplete.
   */
  invokedTransport: AllowedBridgeTransport | null;
  requiredMethods: readonly RequiredBridgeMethod[];
  /** Methods factually observed on the exact renderer; never invented from constants. */
  observedMethods: string[];
  /** Serialized factual request that was invoked through the bridge transport. */
  benignRequest: string | null;
  benignResponse: unknown;
  /**
   * Factual mutation flags from before/after exact-renderer observations.
   * null means evidence was missing/malformed and cannot authorize nondestructive.
   */
  conversationMutated: boolean | null;
  turnStarted: boolean | null;
  settingsChanged: boolean | null;
  beforeSurface: ProbeConversationSurface | null;
  afterSurface: ProbeConversationSurface | null;
  /** True only when complete before/after surface evidence was observed. */
  surfaceEvidenceComplete: boolean;
  reason: string | null;
};

export type ProbeSdkBootstrapSection = {
  complete: boolean;
  sdkRuntime: SdkRuntimeIdentity | null;
  firstBootstrapVersion: string | null;
  secondBootstrapVersion: string | null;
  singleInstance: boolean;
  repeatCount: number;
  reason: string | null;
};

export type ProbeAnchorObservation = {
  name: ProbeAnchorName;
  verdict: AnchorVerdict;
  selector: string | null;
  count: number;
  visible: boolean | null;
  rect: { x: number; y: number; width: number; height: number } | null;
  requiresSignedIn: boolean;
  reason: string | null;
};

export type ProbeAnchorsSection = {
  complete: boolean;
  matrix: ProbeAnchorObservation[];
  pendingUnreachable: ProbeAnchorName[];
  failed: ProbeAnchorName[];
  reason: string | null;
};

export type ProbeSafetySection = {
  complete: boolean;
  role: "development";
  port: 9444;
  hostReadOnly: boolean;
  conversationNondestructive: boolean;
  isolated: boolean;
  devFirst: boolean;
  hostSnapshots: {
    operationStart: HostIdentity;
    preEndpoint: HostIdentity | null;
    preBridge: HostIdentity | null;
    preSdk: HostIdentity | null;
    preAnchor: HostIdentity | null;
    prePersist: HostIdentity | null;
  };
  authoringMain: {
    pid: number | null;
    processStartedAt: string | null;
    survived: boolean | null;
  };
  credentialsInspected: false;
  reason: string | null;
};

export type CompatibilityProbeResult = {
  schemaVersion: typeof COMPATIBILITY_PROBE_RESULT_SCHEMA_VERSION;
  operationId: string;
  status: ProbeOutcome;
  reason: string | null;
  identity: ProbeCorrelationIdentity;
  isolation: ProbeIsolationSection;
  endpoint: ProbeEndpointSection;
  bridge: ProbeBridgeSection;
  sdkBootstrap: ProbeSdkBootstrapSection;
  anchors: ProbeAnchorsSection;
  safety: ProbeSafetySection;
  correlation: {
    ok: boolean;
    mismatches: string[];
  };
  /** True only when status is proven and every required section is complete and correlated. */
  allowsCompatibilityCommit: boolean;
  probedAt: string | null;
};

export type CompatibilityProbeCommitDecision =
  | {
      commit: true;
      status: "proven";
      recordReady: true;
    }
  | {
      commit: false;
      status: Exclude<ProbeOutcome, "proven">;
      recordReady: false;
      reason: string;
    };
