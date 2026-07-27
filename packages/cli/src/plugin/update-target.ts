import type { CdpAdapter } from "../cdp/adapters.ts";
import type { PointOfUseIdentity } from "../cdp/operation.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import type {
  DeclaredRoleEndpoint,
  HostRole,
  VerifiedProcess,
} from "../host/status.ts";
import type { HostIdentity } from "../host/types.ts";
import type { RuntimeAdapters } from "../runtime/adapters.ts";
import { createDefaultRuntimeAdapters } from "../runtime/adapters.ts";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import { createDefaultHostAdapters } from "../host/adapters.ts";
import {
  createDefaultHostStatusAdapters,
} from "../host/process-adapters.ts";
import { inspectHost } from "../host/identity.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import {
  evaluateCompatibility,
  loadCompatibilityRecord,
} from "../host/compatibility-state.ts";
import { gateCompatibilityDependentOperation } from "../host/compatibility-gate.ts";
import { roleEndpoint } from "../host/status.ts";
import {
  runApprovedPluginApplicationOperation,
  type RuntimeApplicationResult,
} from "./application-operation.ts";
import type { ReviewSelectionTuple } from "./review-protocol.ts";
import {
  applySelectedPluginUpdates,
  listPluginUpdateRecommendations,
  mergePluginUpdateApplicationResults,
  type PluginUpdateRecommendation,
} from "./update-transaction.ts";
import type { PluginMutationResult } from "./reconciliation.ts";
import {
  attemptAutomaticDevelopmentReproof,
  createPluginTargetRevalidator,
  preparePluginApplicationTarget,
  readVerifiedSdkRuntimeSource,
} from "./review-target.ts";
import { runPluginUpdateReviewOperation } from "./update-review-operation.ts";
import { loadPluginsState } from "./install-state.ts";

export type PluginUpdateTargetResult =
  | {
      ok: true;
      operationId: string;
      selected: ReviewSelectionTuple[];
      downloaded: ReviewSelectionTuple[];
      installed: ReviewSelectionTuple[];
      artifactCommitted: boolean;
      stateCommitted: boolean;
      authorityChanged: boolean;
      sourceDelivered: boolean;
      applications: RuntimeApplicationResult[];
      mutations: PluginMutationResult[];
      target: TargetIdentity | null;
      residualInventory: {
        callbacks: number;
        sessions: number;
        hasResidentControlPlane: boolean;
      };
    }
  | {
      ok: false;
      operationId: string;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      stateCommitted: boolean;
      authorityChanged: boolean;
      sourceDelivered: boolean;
      applications: RuntimeApplicationResult[];
      mutations: PluginMutationResult[];
    };

export async function finalizeSelectedPluginUpdatesOnDeclaredTarget(options: {
  explodexHome: string;
  operationId: string;
  recommendations: readonly unknown[];
  selected: readonly ReviewSelectionTuple[];
  expectedEnabledPluginIdentities?: readonly ReviewSelectionTuple[];
  fetchArchive(
    recommendation: PluginUpdateRecommendation,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  reviewProtocol: {
    nonce: string;
    activationSecret: string;
    target: TargetIdentity;
  };
  runtime: RuntimeAdapters;
  role: HostRole;
  homeIdentity: string;
  host: HostIdentity;
  process: VerifiedProcess;
  endpoint: DeclaredRoleEndpoint;
  cdp: CdpAdapter;
  revalidate(): Promise<PointOfUseIdentity>;
  sdkRuntimeSource: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PluginUpdateTargetResult> {
  const finalizeGrant = (snapshots: Parameters<
    typeof runApprovedPluginApplicationOperation
  >[0]["snapshots"]) =>
    runApprovedPluginApplicationOperation({
      runtime: options.runtime,
      operationId: options.operationId,
      nonce: options.reviewProtocol.nonce,
      activationSecret: options.reviewProtocol.activationSecret,
      role: options.role,
      homeIdentity: options.homeIdentity,
      host: options.host,
      process: options.process,
      endpoint: options.endpoint,
      cdp: options.cdp,
      expectedTarget: options.reviewProtocol.target,
      revalidate: options.revalidate,
      sdkRuntimeSource: options.sdkRuntimeSource,
      snapshots,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

  let application: Awaited<
    ReturnType<typeof runApprovedPluginApplicationOperation>
  > | null = null;
  const transaction = await applySelectedPluginUpdates({
    explodexHome: options.explodexHome,
    recommendations: options.recommendations,
    selected: options.selected,
    expectedEnabledPluginIdentities: options.expectedEnabledPluginIdentities,
    fetchArchive: options.fetchArchive,
    operationId: options.operationId,
    runtimeAdapters: options.runtime,
    signal: options.signal,
    afterStateCommit: async ({ snapshots }) => {
      application = await finalizeGrant(snapshots);
    },
  });
  if (!transaction.ok) {
    const completedApplication = application as Awaited<
      ReturnType<typeof runApprovedPluginApplicationOperation>
    > | null;
    if (completedApplication !== null) {
      return {
        ok: false,
        operationId: options.operationId,
        code: transaction.code,
        message: transaction.message,
        details: transaction.details,
        stateCommitted: transaction.stateCommitted,
        authorityChanged: transaction.authorityChanged,
        sourceDelivered: completedApplication.sourceDelivered,
        applications: completedApplication.applications,
        mutations: mergePluginUpdateApplicationResults({
          mutations: transaction.mutations,
          applications: completedApplication.applications,
          target: completedApplication.target ?? null,
        }),
      };
    }
    const cleanup = await finalizeGrant([]);
    if (!cleanup.ok) {
      return {
        ok: false,
        operationId: options.operationId,
        code: "plugin.update.cleanup-failed",
        message:
          "Plugin update failed and its renderer capability could not be removed cleanly.",
        details: { transaction, cleanup },
        stateCommitted: transaction.stateCommitted,
        authorityChanged: transaction.authorityChanged,
        sourceDelivered: false,
        applications: [],
        mutations: transaction.mutations,
      };
    }
    return {
      ok: false,
      operationId: options.operationId,
      code: transaction.code,
      message: transaction.message,
      details: transaction.details,
      stateCommitted: transaction.stateCommitted,
      authorityChanged: transaction.authorityChanged,
      sourceDelivered: false,
      applications: [],
      mutations: transaction.mutations,
    };
  }
  if (application === null) {
    application = await finalizeGrant([]);
  }
  if (!application.ok) {
    return {
      ok: false,
      operationId: options.operationId,
      code: application.code,
      message: application.message,
      details: application.details,
      stateCommitted: transaction.stateCommitted,
      authorityChanged: transaction.authorityChanged,
      sourceDelivered: application.sourceDelivered,
      applications: application.applications,
      mutations: mergePluginUpdateApplicationResults({
        mutations: transaction.mutations,
        applications: application.applications,
        target: null,
      }),
    };
  }
  return {
    ok: true,
    operationId: options.operationId,
    selected: transaction.selected,
    downloaded: transaction.downloaded,
    installed: transaction.installed,
    artifactCommitted: transaction.artifactCommitted,
    stateCommitted: transaction.stateCommitted,
    authorityChanged: transaction.authorityChanged,
    sourceDelivered: application.sourceDelivered,
    applications: application.applications,
    mutations: mergePluginUpdateApplicationResults({
      mutations: transaction.mutations,
      applications: application.applications,
      target: application.target,
    }),
    target: application.target,
    residualInventory: application.residualInventory,
  };
}

export async function runUpdateOnDeclaredTarget(options: {
  role: HostRole;
  explodexHome: string;
  devRoot?: string;
  env: NodeJS.ProcessEnv;
  recommendations: readonly unknown[];
  fetchArchive(
    recommendation: PluginUpdateRecommendation,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<
  | (PluginUpdateTargetResult & {
      reviewed: ReviewSelectionTuple[];
      selected: ReviewSelectionTuple[];
    })
  | {
      ok: false;
      operationId: string;
      code: string;
      message: string;
      stateCommitted: false;
      authorityChanged: false;
      sourceDelivered: false;
      applications: [];
      mutations: [];
    }
> {
  const unavailable = (code: string, message: string) => ({
    ok: false as const,
    operationId: "plugin-update",
    code,
    message,
    stateCommitted: false as const,
    authorityChanged: false as const,
    sourceDelivered: false as const,
    applications: [] as [],
    mutations: [] as [],
  });
  if (options.role === "main") {
    return unavailable(
      "main.authorization-required",
      "Plugin update application to the protected main requires a fresh explicit main-authorization checkpoint that is not available in this operation.",
    );
  }
  const hostAdapters = await createDefaultHostAdapters();
  const statusAdapters = await createDefaultHostStatusAdapters();
  const sdkRuntime = await resolveSdkRuntimeIdentityForCli();
  const inspection = await inspectHost({ adapters: hostAdapters });
  if (!inspection.ok || inspection.host === null) {
    return unavailable("host.invalid", inspection.error.message);
  }
  let persisted = await loadCompatibilityRecord({
    adapters: hostAdapters,
    explodexHome: options.explodexHome,
  });
  let compatibility = evaluateCompatibility({
    host: inspection.host,
    sdkRuntime,
    persisted,
    runningProcess: null,
  });
  let gate = gateCompatibilityDependentOperation({
    operation: "review",
    compatibility,
  });
  if (
    !gate.allowed &&
    gate.error.code === "compatibility_stale" &&
    options.role === "development"
  ) {
    const reproved = await attemptAutomaticDevelopmentReproof({
      explodexHome: options.explodexHome,
      devRoot: options.devRoot,
      env: options.env,
      host: inspection.host,
      hostAdapters,
      sdkRuntime,
      signal: options.signal,
    });
    if (reproved.ok) {
      persisted = await loadCompatibilityRecord({
        adapters: hostAdapters,
        explodexHome: options.explodexHome,
      });
      compatibility = evaluateCompatibility({
        host: inspection.host,
        sdkRuntime,
        persisted,
      });
      gate = gateCompatibilityDependentOperation({
        operation: "review",
        compatibility,
      });
    }
  }
  if (!gate.allowed) {
    return unavailable(
      gate.error.code === "compatibility_stale"
        ? "compatibility.drifted"
        : "compatibility.unproven",
      gate.error.message,
    );
  }
  const listing = await listPluginUpdateRecommendations({
    explodexHome: options.explodexHome,
    recommendations: options.recommendations,
    signal: options.signal,
  });
  if (!listing.ok) return unavailable(listing.code, listing.message);
  if (listing.recommendations.length === 0) {
    return {
      ok: true,
      operationId: "plugin-update",
      reviewed: [],
      selected: [],
      downloaded: [],
      installed: [],
      artifactCommitted: false,
      stateCommitted: false,
      authorityChanged: false,
      sourceDelivered: false,
      applications: [],
      mutations: [],
      target: null,
      residualInventory: {
        callbacks: 0,
        sessions: 0,
        hasResidentControlPlane: false,
      },
    };
  }
  const prepared = await preparePluginApplicationTarget({
    role: options.role,
    explodexHome: options.explodexHome,
    devRoot: options.devRoot,
    env: options.env,
    host: inspection.host,
  });
  if (!prepared.ok) return unavailable(prepared.code, prepared.message);
  let sdkRuntimeSource: string;
  try {
    sdkRuntimeSource = await readVerifiedSdkRuntimeSource(sdkRuntime);
  } catch (error: unknown) {
    return unavailable(
      "compatibility.unproven",
      error instanceof Error
        ? error.message
        : "The exact SDK runtime bytes are unavailable.",
    );
  }
  const loaded = await loadPluginsState({
    explodexHome: options.explodexHome,
  });
  if (loaded.status !== "valid") {
    return unavailable(
      "plugin.update.state-invalid",
      "Update review requires valid authoritative plugin state.",
    );
  }
  const enabledPluginIds = Object.keys(loaded.state.plugins)
    .filter((id) => loaded.state.plugins[id]!.enabled !== null)
    .sort();
  const enabledPluginIdentities = enabledPluginIds.map((id) => ({
    id,
    ...loaded.state.plugins[id]!.enabled!,
  }));
  const runtime = await createDefaultRuntimeAdapters();
  const cdp = createNodeCdpAdapter();
  const revalidate = createPluginTargetRevalidator({
    role: options.role,
    explodexHome: options.explodexHome,
    expectedHost: inspection.host,
    expected: prepared.target,
    hostAdapters,
    statusAdapters,
    sdkRuntime,
  });
  const review = await runPluginUpdateReviewOperation({
    runtime,
    role: options.role,
    homeIdentity: options.explodexHome,
    host: inspection.host,
    process: prepared.target.process,
    endpoint: roleEndpoint(options.role),
    cdp,
    expectedTargetId: prepared.target.expectedTargetId,
    revalidate,
    sdkRuntimeSource,
    artifacts: listing.recommendations.map((recommendation) => ({
      id: recommendation.id,
      displayName: recommendation.displayName,
      description: recommendation.description,
      version: recommendation.version,
      payloadSha256: recommendation.payloadSha256,
      sdkRange: recommendation.sdkRange,
      sourceLabel: recommendation.sourceLabel,
    })),
    enabledPluginIdentities,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!review.ok) {
    if (review.cleanupProtocol !== undefined) {
      const cleanup = await runApprovedPluginApplicationOperation({
        runtime,
        operationId: review.operationId,
        nonce: review.cleanupProtocol.nonce,
        activationSecret: "",
        role: options.role,
        homeIdentity: options.explodexHome,
        host: inspection.host,
        process: prepared.target.process,
        endpoint: roleEndpoint(options.role),
        cdp,
        expectedTarget: review.cleanupProtocol.target,
        revalidate,
        sdkRuntimeSource,
        snapshots: [],
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      if (!cleanup.ok) {
        return unavailable(
          "plugin.update.cleanup-failed",
          "Rejected update selection could not remove its renderer capability cleanly.",
        );
      }
    }
    return unavailable(review.code, review.message);
  }
  const applied = await finalizeSelectedPluginUpdatesOnDeclaredTarget({
    explodexHome: options.explodexHome,
    operationId: review.operationId,
    recommendations: options.recommendations,
    selected: review.selected,
    expectedEnabledPluginIdentities: enabledPluginIdentities,
    fetchArchive: options.fetchArchive,
    reviewProtocol: review.protocol,
    runtime,
    role: options.role,
    homeIdentity: options.explodexHome,
    host: inspection.host,
    process: prepared.target.process,
    endpoint: roleEndpoint(options.role),
    cdp,
    revalidate,
    sdkRuntimeSource,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  return {
    ...applied,
    reviewed: listing.recommendations.map(({ id, version, payloadSha256 }) => ({
      id,
      version,
      payloadSha256,
    })),
    selected: review.selected,
  };
}
