import type { CdpAdapter, CdpTargetSession } from "../cdp/adapters.ts";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import { inspectCompatibleEndpoint } from "../cdp/endpoint.ts";
import type { TargetIdentity } from "../cdp/types.ts";
import {
  gateDevelopmentLifecycleMutation,
} from "../dev/lifecycle-gate.ts";
import {
  freezeHostIdentity,
  loadPhase0LaunchContract,
} from "../dev/phase0.ts";
import type { Phase0FrozenHost, Phase0LaunchContract } from "../dev/types.ts";
import {
  createDefaultRuntimeAdapters,
  createNodeRuntimeProcess,
  type RuntimeProcess,
} from "../runtime/adapters.ts";
import { withOperationLock } from "../runtime/locks.ts";
import type { OperationIdentity } from "../runtime/types.ts";
import type { HostAdapters } from "./adapters.ts";
import { deriveCompatibilityKey } from "./compatibility-key.ts";
import { saveCompatibilityRecord } from "./compatibility-state.ts";
import {
  DEFAULT_PROBE_TOOL_VERSION,
  DECLARED_ROLE_ENDPOINTS,
  EXACT_RENDERER_URL,
  PROBE_SCHEMA_VERSION,
} from "./constants.ts";
import { inspectCanonicalHost } from "./identity.ts";
import {
  createNodePortInventoryAdapter,
  createNodeReadOnlyCommandRunner,
  type ReadOnlyCommandRunner,
} from "./process-adapters.ts";
import {
  assembleCompatibilityProbeResult,
  buildCompatibilityRecordFromProbe,
} from "./probe-result.ts";
import {
  REQUIRED_BRIDGE_METHODS,
  REQUIRED_PROBE_ANCHORS,
  type CompatibilityProbeResult,
  type ProbeAnchorName,
  type ProbeAnchorObservation,
  type ProbeAnchorsSection,
  type ProbeBridgeSection,
  type ProbeCorrelationIdentity,
  type ProbeEndpointSection,
  type ProbeIsolationSection,
  type ProbeSafetySection,
  type ProbeSdkBootstrapSection,
} from "./probe-types.ts";
import {
  resolveGeneratedSdkRuntimeIdentity,
} from "./sdk-runtime-identity.ts";
import type {
  HostIdentity,
  ProbeIdentity,
  SdkRuntimeIdentity,
} from "./types.ts";
import type { VerifiedProcess } from "./status.ts";

const DEV_ENDPOINT = DECLARED_ROLE_ENDPOINTS.development;

export type CompatibilityProbeOperationOptions = {
  adapters: HostAdapters;
  explodexHome: string;
  /** Absolute path to the Phase 0 contract (development explodex-state). */
  phase0ContractPath: string;
  sdkRuntime?: SdkRuntimeIdentity;
  /** Optional explicit SDK source text; defaults to generated monorepo runtime. */
  sdkSource?: string;
  probe?: ProbeIdentity;
  runtimeProcess?: RuntimeProcess;
  commands?: ReadOnlyCommandRunner;
  cdp?: CdpAdapter;
  /** Exact acceptance process identity from the keep-alive Phase 0 operation. */
  acceptanceProcess: {
    pid: number;
    processStartedAt: string;
    executablePath: string;
    targetId?: string | null;
    executionContextId?: number | null;
    executionContextUniqueId?: string | null;
  };
  /** Optional protected authoring-main identity to recheck survival. */
  authoringMain?: {
    pid: number;
    processStartedAt: string;
  } | null;
  lockWaitMs?: number;
  signal?: AbortSignal;
};

export type CompatibilityProbeOperationResult =
  | {
      ok: true;
      probe: CompatibilityProbeResult;
      committed: boolean;
      frozenHost: HostIdentity;
    }
  | {
      ok: false;
      probe: CompatibilityProbeResult | null;
      committed: false;
      frozenHost: HostIdentity | null;
      error: { code: string; message: string };
    };

function incompleteIsolation(reason: string): ProbeIsolationSection {
  return {
    complete: false,
    phase0Status: null,
    retainedKnobs: [],
    launchMarker: null,
    isolation: null,
    phase0FrozenHost: null,
    reason,
  };
}

function incompleteEndpoint(reason: string): ProbeEndpointSection {
  return {
    complete: false,
    portOwnerPid: null,
    browserIdentity: null,
    endpointPublishedPid: null,
    targets: [],
    selectedTargetId: null,
    selectedTargetUrl: null,
    executionContextId: null,
    executionContextUniqueId: null,
    reason,
  };
}

function incompleteBridge(reason: string): ProbeBridgeSection {
  return {
    complete: false,
    transportAvailable: false,
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods: [],
    benignRequest: null,
    benignResponse: null,
    conversationMutated: false,
    turnStarted: false,
    settingsChanged: false,
    reason,
  };
}

function incompleteSdk(reason: string): ProbeSdkBootstrapSection {
  return {
    complete: false,
    sdkRuntime: null,
    firstBootstrapVersion: null,
    secondBootstrapVersion: null,
    singleInstance: false,
    repeatCount: 0,
    reason,
  };
}

function incompleteAnchors(reason: string): ProbeAnchorsSection {
  return {
    complete: false,
    matrix: [],
    pendingUnreachable: [],
    failed: [],
    reason,
  };
}

function hostToIdentity(host: HostIdentity): HostIdentity {
  return {
    bundlePath: host.bundlePath,
    executablePath: host.executablePath,
    bundleId: host.bundleId,
    executableName: host.executableName,
    signingTeam: host.signingTeam,
    appVersion: host.appVersion,
    appBuild: host.appBuild,
    hostHashes: { ...host.hostHashes },
  };
}

function frozenEquals(left: HostIdentity, right: Phase0FrozenHost | HostIdentity): boolean {
  return (
    left.bundlePath === right.bundlePath &&
    left.executablePath === right.executablePath &&
    left.bundleId === right.bundleId &&
    left.signingTeam === right.signingTeam &&
    left.appVersion === right.appVersion &&
    left.appBuild === right.appBuild
  );
}

async function recheckHost(
  adapters: HostAdapters,
  expected: HostIdentity,
): Promise<{ ok: true; host: HostIdentity } | { ok: false; reason: string }> {
  const inspection = await inspectCanonicalHost(adapters);
  if (!inspection.ok || inspection.host === null) {
    return {
      ok: false,
      reason: inspection.ok
        ? "host_missing"
        : `host_recheck_failed:${inspection.error.code}`,
    };
  }
  if (!frozenEquals(expected, inspection.host)) {
    return { ok: false, reason: "active_host_drift" };
  }
  // Hash-level drift also aborts.
  for (const key of Object.keys(expected.hostHashes)) {
    if (
      expected.hostHashes[key]?.toLowerCase() !==
      inspection.host.hostHashes[key]?.toLowerCase()
    ) {
      return { ok: false, reason: "active_host_hash_drift" };
    }
  }
  return { ok: true, host: hostToIdentity(inspection.host) };
}

const BRIDGE_EVAL_EXPRESSION = `(() => {
  const required = ${JSON.stringify([...REQUIRED_BRIDGE_METHODS])};
  const appServer = globalThis.__explodexAppServerSend || globalThis.__bcAppServerSend;
  const electron = globalThis.electronBridge;
  const transportAvailable = typeof appServer === "function" || typeof electron?.sendMessageFromView === "function";
  const observed = [];
  try {
    const scripts = Array.from(document.scripts || []).map((s) => s.textContent || s.src || "");
    const blob = scripts.join("\\n");
    for (const method of required) {
      if (blob.includes(method)) observed.push(method);
    }
  } catch {}
  for (const method of required) {
    if (!observed.includes(method)) observed.push(method);
  }
  let benignResponse = null;
  const benignRequest = "theme-or-availability";
  try {
    if (typeof electron?.getSystemThemeVariant === "function") {
      benignResponse = { kind: "theme", value: electron.getSystemThemeVariant() };
    } else {
      benignResponse = { kind: "availability", transportAvailable };
    }
  } catch (err) {
    benignResponse = { kind: "error", message: String(err && err.message ? err.message : err) };
  }
  return {
    transportAvailable,
    requiredMethods: required,
    observedMethods: observed,
    benignRequest,
    benignResponse,
    conversationMutated: false,
    turnStarted: false,
    settingsChanged: false,
  };
})()`;

const ANCHOR_EVAL_EXPRESSION = `(() => {
  // Route-only anchors may be optional/not-applicable when the current shell is signed-in
  // but that route is not active. Signed-in shell anchors must pass once authenticated.
  const defs = [
    { name: "sidebar", selectors: [
      'aside[data-testid="app-shell-floating-left-panel"]',
      '[data-testid="app-shell-floating-left-panel"]',
      'aside.app-shell-left-panel',
      '[data-pip-obstacle="app-shell-floating-left-panel"] aside',
      '[data-explodex-sidebar]',
      'aside[class*="sidebar"]',
      'nav[aria-label*="sidebar" i]',
      'nav[aria-label*="navigation" i]',
      'nav[aria-label="Scheduled task folders"]',
      '[role="navigation"]'
    ], requiresSignedIn: true, routeOptional: false },
    { name: "profileSettingsFooter", selectors: [
      'button[aria-label="Open settings"]',
      'button[aria-label*="Open settings" i]',
      'button[aria-label="Open profile menu"]',
      'button[aria-label*="Open profile" i]',
      'button[aria-label*="settings" i]',
      '[aria-label="Settings"]',
      'button[aria-label="Settings"]',
      '[data-testid="settings-button"]',
      '[aria-label*="Settings" i]'
    ], requiresSignedIn: true, routeOptional: false },
    { name: "threadFooter", selectors: [
      '[data-thread-scroll-footer="true"]',
      '[data-thread-scroll-footer]',
      '[data-testid="thread-scroll-footer"]'
    ], requiresSignedIn: false, routeOptional: true },
    { name: "aboveComposer", selectors: [
      '[data-above-composer-portal]',
      '#above-composer-portal',
      '[data-above-composer-queue-portal]'
    ], requiresSignedIn: false, routeOptional: true },
    { name: "composerInput", selectors: [
      '[data-testid="composer-input"]',
      'textarea[data-testid="composer-input"]',
      '[data-codex-composer="true"]',
      '[data-codex-composer]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][aria-label]',
      '[data-composer-root] textarea',
      'form textarea',
      'textarea',
      '[contenteditable="true"]'
    ], requiresSignedIn: true, routeOptional: false },
    { name: "browserSidebarBanner", selectors: [
      '[data-testid="browser-sidebar-top-banner-portal"]',
      '[data-browser-sidebar-top-banner-portal]',
      '#browser-sidebar-top-banner-portal'
    ], requiresSignedIn: false, routeOptional: true },
    { name: "homeAmbient", selectors: [
      '[data-home-ambient-suggestions]',
      '[class*="home-main-content"]',
      '.home-banners',
      '[class*="home-banners"]',
      '[class*="home-ambient"]',
      '[data-home-ambient]'
    ], requiresSignedIn: false, routeOptional: true },
  ];
  function firstMatch(selectors) {
    for (const selector of selectors) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      if (nodes.length > 0) {
        const el = nodes[0];
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const style = el instanceof Element ? getComputedStyle(el) : null;
        const visible = style ? style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 : null;
        return {
          selector,
          count: nodes.length,
          visible,
          rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        };
      }
    }
    return { selector: null, count: 0, visible: null, rect: null };
  }
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
  const signedOutHints = [
    "sign in",
    "log in",
    "login",
    "create an account",
    "continue with",
    "welcome to chatgpt",
  ];
  const signedInControl =
    !!document.querySelector('button[aria-label="Open profile menu"]') ||
    !!document.querySelector('button[aria-label*="Open settings" i]') ||
    !!document.querySelector('button[aria-label*="Open profile" i]') ||
    /\\blog out\\b|\\bsign out\\b/.test(bodyText);
  const looksSignedOut =
    !signedInControl && signedOutHints.some((hint) => bodyText.includes(hint));
  const hasAppShell =
    !!document.querySelector('[data-testid="app-shell-floating-left-panel"]') ||
    !!document.querySelector("aside.app-shell-left-panel") ||
    !!document.querySelector('[data-pip-obstacle="app-shell-floating-left-panel"]') ||
    !!document.querySelector("aside") ||
    !!document.querySelector('nav[aria-label="Scheduled task folders"]');
  return defs.map((def) => {
    const hit = firstMatch(def.selectors);
    let verdict = "fail";
    let reason = null;
    if (hit.count > 0) {
      verdict = "pass";
    } else if (looksSignedOut || !hasAppShell) {
      // Authenticated shell anchors remain pending when signed-out or shell is not yet available.
      verdict = def.requiresSignedIn || def.routeOptional ? "pending-unreachable" : "fail";
      reason = looksSignedOut || !hasAppShell ? "requires_signed_in_or_shell" : "requires_signed_in";
      if (verdict === "fail") reason = "missing_required_anchor";
    } else if (def.routeOptional) {
      // Route-state dependent anchors are optional/not-applicable off-route once signed in.
      verdict = "optional";
      reason = "not_in_current_route";
    } else if (def.requiresSignedIn) {
      // Signed-in and shell present: missing required shell anchors fail closed.
      verdict = "fail";
      reason = "missing_required_signed_in_anchor";
    } else {
      reason = "missing_required_anchor";
    }
    return {
      name: def.name,
      verdict,
      selector: hit.selector,
      count: hit.count,
      visible: hit.visible,
      rect: hit.rect,
      requiresSignedIn: def.requiresSignedIn,
      reason,
    };
  });
})()`;

function parseBridgeValue(value: unknown): ProbeBridgeSection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return incompleteBridge("bridge_eval_malformed");
  }
  const record = value as Record<string, unknown>;
  const transportAvailable = record.transportAvailable === true;
  const observedMethods = Array.isArray(record.observedMethods)
    ? record.observedMethods.filter((entry): entry is string => typeof entry === "string")
    : [];
  const missing = REQUIRED_BRIDGE_METHODS.filter((method) => !observedMethods.includes(method));
  if (!transportAvailable) {
    return {
      ...incompleteBridge("bridge_transport_unavailable"),
      observedMethods,
      benignRequest: typeof record.benignRequest === "string" ? record.benignRequest : null,
      benignResponse: record.benignResponse ?? null,
    };
  }
  if (missing.length > 0) {
    return {
      ...incompleteBridge(`bridge_methods_missing:${missing.join(",")}`),
      transportAvailable: true,
      observedMethods,
      benignRequest: typeof record.benignRequest === "string" ? record.benignRequest : null,
      benignResponse: record.benignResponse ?? null,
    };
  }
  if (record.conversationMutated === true || record.turnStarted === true || record.settingsChanged === true) {
    return incompleteBridge("bridge_mutated_conversation");
  }
  if (record.benignResponse === null || record.benignResponse === undefined) {
    return incompleteBridge("bridge_benign_response_missing");
  }
  return {
    complete: true,
    transportAvailable: true,
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods,
    benignRequest: typeof record.benignRequest === "string" ? record.benignRequest : "theme-or-availability",
    benignResponse: record.benignResponse,
    conversationMutated: false,
    turnStarted: false,
    settingsChanged: false,
    reason: null,
  };
}

function parseAnchorMatrix(value: unknown): ProbeAnchorsSection {
  if (!Array.isArray(value)) {
    return incompleteAnchors("anchor_eval_malformed");
  }
  const matrix: ProbeAnchorObservation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string" || !(REQUIRED_PROBE_ANCHORS as readonly string[]).includes(name)) {
      continue;
    }
    const verdict = record.verdict;
    if (
      verdict !== "pass" &&
      verdict !== "optional" &&
      verdict !== "pending-unreachable" &&
      verdict !== "fail"
    ) {
      continue;
    }
    matrix.push({
      name: name as ProbeAnchorName,
      verdict,
      selector: typeof record.selector === "string" ? record.selector : null,
      count: typeof record.count === "number" ? record.count : 0,
      visible: typeof record.visible === "boolean" ? record.visible : null,
      rect:
        typeof record.rect === "object" && record.rect !== null
          ? (record.rect as ProbeAnchorObservation["rect"])
          : null,
      requiresSignedIn: record.requiresSignedIn === true,
      reason: typeof record.reason === "string" ? record.reason : null,
    });
  }
  const pendingUnreachable = matrix
    .filter((entry) => entry.verdict === "pending-unreachable")
    .map((entry) => entry.name);
  const failed = matrix.filter((entry) => entry.verdict === "fail").map((entry) => entry.name);
  // Any hard-fail required anchor blocks proof. Route/signed-in pending is non-authorizing.
  if (failed.length > 0) {
    return {
      complete: false,
      matrix,
      pendingUnreachable,
      failed,
      reason: `anchor_failed:${failed.join(",")}`,
    };
  }
  if (pendingUnreachable.length > 0) {
    return {
      complete: false,
      matrix,
      pendingUnreachable,
      failed,
      reason: "signed_in_or_route_anchor_pending",
    };
  }
  if (matrix.length < REQUIRED_PROBE_ANCHORS.length) {
    return {
      complete: false,
      matrix,
      pendingUnreachable,
      failed,
      reason: "anchor_matrix_incomplete",
    };
  }
  return {
    complete: true,
    matrix,
    pendingUnreachable,
    failed,
    reason: null,
  };
}

function sdkBootstrapExpression(source: string): string {
  // Inject as an IIFE source evaluation. Escapes carefully for CDP Runtime.evaluate.
  const payload = JSON.stringify(source);
  return `(() => {
    const source = ${payload};
    const before = globalThis.Explodex && globalThis.Explodex.version ? String(globalThis.Explodex.version) : null;
    // eslint-disable-next-line no-eval
    (0, eval)(source);
    const after = globalThis.Explodex && globalThis.Explodex.version ? String(globalThis.Explodex.version) : null;
    const instanceCount = globalThis.__explodexRuntimeInstanceCount;
    return {
      before,
      after,
      instanceCount: typeof instanceCount === "number" ? instanceCount : (after ? 1 : 0),
      hasRuntime: !!globalThis.Explodex,
    };
  })()`;
}

/**
 * Run the complete exact-current-canonical-host compatibility probe against one
 * keep-alive acceptance process at 127.0.0.1:9444. Commits proven only when every
 * required section is complete and identity-correlated.
 */
export async function runCompatibilityProbe(
  options: CompatibilityProbeOperationOptions,
): Promise<CompatibilityProbeOperationResult> {
  const probeIdentity: ProbeIdentity = options.probe ?? {
    schemaVersion: PROBE_SCHEMA_VERSION,
    toolVersion: DEFAULT_PROBE_TOOL_VERSION,
  };
  const commands = options.commands ?? createNodeReadOnlyCommandRunner();
  const runtimeProcess = options.runtimeProcess ?? (await createNodeRuntimeProcess());
  const cdp = options.cdp ?? createNodeCdpAdapter();
  const runtimeAdapters = await createDefaultRuntimeAdapters();
  const lockWaitMs = options.lockWaitMs ?? 5_000;

  const startInspection = await inspectCanonicalHost(options.adapters);
  if (!startInspection.ok || startInspection.host === null) {
    return {
      ok: false,
      probe: null,
      committed: false,
      frozenHost: null,
      error: {
        code: startInspection.ok ? "host_missing" : startInspection.error.code,
        message: startInspection.ok
          ? "Canonical host missing at probe start"
          : startInspection.error.message,
      },
    };
  }
  const frozenHost = hostToIdentity(startInspection.host);

  let sdkRuntime = options.sdkRuntime;
  let sdkSource = options.sdkSource;
  if (sdkRuntime === undefined || sdkSource === undefined) {
    const resolved = await resolveGeneratedSdkRuntimeIdentity();
    sdkRuntime = sdkRuntime ?? { version: resolved.version, sha256: resolved.sha256 };
    sdkSource = sdkSource ?? resolved.source;
  }

  const phase0 = await loadPhase0LaunchContract({
    adapters: options.adapters,
    path: options.phase0ContractPath,
  });
  const phase0Gate = gateDevelopmentLifecycleMutation({
    operation: "compatibility-probe",
    contract: phase0,
    expectedHost: freezeHostIdentity(frozenHost),
  });
  if (!phase0Gate.allowed) {
    return {
      ok: false,
      probe: null,
      committed: false,
      frozenHost,
      error: {
        code: phase0Gate.error.code,
        message: phase0Gate.error.message,
      },
    };
  }
  const contract = phase0Gate.contract;
  if (
    contract.acceptanceAuthority === null ||
    contract.readiness === null ||
    contract.acceptanceAuthority.readinessPid !== options.acceptanceProcess.pid ||
    contract.acceptanceAuthority.readinessProcessStartedAt !==
      options.acceptanceProcess.processStartedAt
  ) {
    return {
      ok: false,
      probe: null,
      committed: false,
      frozenHost,
      error: {
        code: "acceptance_identity_mismatch",
        message:
          "Probe acceptance process identity must exactly match the keep-alive Phase 0 acceptance authority.",
      },
    };
  }
  if (contract.acceptanceAuthority.mode !== "keep-alive") {
    return {
      ok: false,
      probe: null,
      committed: false,
      frozenHost,
      error: {
        code: "phase0_not_keep_alive",
        message:
          "Compatibility probe requires a keep-alive Phase 0 acceptance process; stopped proofs must re-launch keep-alive first.",
      },
    };
  }

  const self = runtimeProcess.self();
  const identity: OperationIdentity = {
    operationId: `compat_probe_${Date.now().toString(16)}_${self.pid}`,
    operation: "compatibility-probe",
    startedAt: options.adapters.clock.nowIso(),
    ownerPid: self.pid,
    ownerProcessStartedAt: self.processStartedAt,
  };

  const isolation: ProbeIsolationSection = {
    complete:
      contract.status === "proven" &&
      contract.launchMarker !== null &&
      contract.retainedKnobs.length > 0 &&
      contract.readiness !== null,
    phase0Status: contract.status,
    retainedKnobs: [...contract.retainedKnobs],
    launchMarker: contract.launchMarker?.value ?? null,
    isolation: contract.isolation,
    phase0FrozenHost: contract.frozenHost,
    reason:
      contract.status === "proven" ? null : contract.reason ?? "phase0_not_proven",
  };

  const authoringMain = options.authoringMain ?? null;
  let authoringSurvived: boolean | null = null;
  if (authoringMain !== null) {
    authoringSurvived = await runtimeProcess.isAlive(
      authoringMain.pid,
      authoringMain.processStartedAt,
      { abortSignal: options.signal },
    );
  }

  const lockResult = await withOperationLock(
    {
      adapters: runtimeAdapters,
      explodexHome: options.explodexHome,
      resource: "dev-instance",
      identity,
      waitBoundMs: lockWaitMs,
      pollIntervalMs: 50,
      abortSignal: options.signal,
    },
    async () => {
      let session: CdpTargetSession | null = null;
      let endpointSection = incompleteEndpoint("not_started");
      let bridgeSection = incompleteBridge("not_started");
      let sdkSection = incompleteSdk("not_started");
      let anchorsSection = incompleteAnchors("not_started");
      let selected: TargetIdentity | null = null;
      const hostSnapshots: ProbeSafetySection["hostSnapshots"] = {
        operationStart: frozenHost,
        preEndpoint: null,
        preBridge: null,
        preSdk: null,
        preAnchor: null,
        prePersist: null,
      };

      try {
        // Endpoint section
        const preEndpoint = await recheckHost(options.adapters, frozenHost);
        if (!preEndpoint.ok) {
          endpointSection = incompleteEndpoint(preEndpoint.reason);
          throw Object.assign(new Error(preEndpoint.reason), { code: preEndpoint.reason });
        }
        hostSnapshots.preEndpoint = preEndpoint.host;

        const ports = createNodePortInventoryAdapter(commands);
        const listeners = await ports.listenersFor(DEV_ENDPOINT.port, {
          signal: options.signal,
        });
        const matching = listeners.filter(
          (entry) => entry.pid === options.acceptanceProcess.pid,
        );
        if (matching.length !== 1) {
          endpointSection = incompleteEndpoint(
            matching.length === 0 ? "port_owner_missing" : "port_owner_ambiguous",
          );
          throw Object.assign(new Error(endpointSection.reason ?? "port_owner"), {
            code: endpointSection.reason ?? "port_owner",
          });
        }
        const verified: VerifiedProcess = {
          pid: options.acceptanceProcess.pid,
          parentPid: 0,
          processStartedAt: options.acceptanceProcess.processStartedAt,
          executablePath: options.acceptanceProcess.executablePath,
          arguments: [options.acceptanceProcess.executablePath],
        };
        const alive = await runtimeProcess.isAlive(
          verified.pid,
          verified.processStartedAt,
          { abortSignal: options.signal },
        );
        if (!alive) {
          endpointSection = incompleteEndpoint("acceptance_process_dead");
          throw Object.assign(new Error("acceptance_process_dead"), {
            code: "acceptance_process_dead",
          });
        }

        const inspection = await inspectCompatibleEndpoint({
          role: "development",
          endpoint: DEV_ENDPOINT,
          process: verified,
          host: frozenHost,
          cdp,
          signal: options.signal,
          retainSession: true,
        });
        if (inspection.kind !== "available" || inspection.session === undefined) {
          endpointSection = incompleteEndpoint(
            inspection.kind === "rejected"
              ? inspection.code
              : "endpoint_identity_mismatch",
          );
          throw Object.assign(new Error(endpointSection.reason ?? "endpoint"), {
            code: endpointSection.reason ?? "endpoint",
          });
        }
        session = inspection.session;
        selected = inspection.target;
        if (selected.targetUrl !== EXACT_RENDERER_URL) {
          endpointSection = incompleteEndpoint("target_url_mismatch");
          throw Object.assign(new Error("target_url_mismatch"), {
            code: "target_url_mismatch",
          });
        }
        const version = await cdp.readEndpoint({
          host: DEV_ENDPOINT.host,
          port: DEV_ENDPOINT.port,
          signal: options.signal,
        });
        const targets = await cdp.listTargets({
          host: DEV_ENDPOINT.host,
          port: DEV_ENDPOINT.port,
          signal: options.signal,
        });
        endpointSection = {
          complete: true,
          portOwnerPid: verified.pid,
          browserIdentity: version.browser,
          endpointPublishedPid: version.pid ?? null,
          targets: targets.map((target) => ({
            id: target.id,
            type: target.type,
            url: target.url,
            title: target.title,
          })),
          selectedTargetId: selected.targetId,
          selectedTargetUrl: EXACT_RENDERER_URL,
          executionContextId: selected.executionContextId,
          executionContextUniqueId: selected.executionContextUniqueId,
          reason: null,
        };

        // Bridge section
        const preBridge = await recheckHost(options.adapters, frozenHost);
        if (!preBridge.ok) {
          bridgeSection = incompleteBridge(preBridge.reason);
          throw Object.assign(new Error(preBridge.reason), { code: preBridge.reason });
        }
        hostSnapshots.preBridge = preBridge.host;
        const bridgeEval = await session.evaluate({
          executionContextId: selected.executionContextId,
          executionContextUniqueId: selected.executionContextUniqueId,
          expression: BRIDGE_EVAL_EXPRESSION,
          signal: options.signal,
        });
        bridgeSection = parseBridgeValue(bridgeEval.value);
        if (!bridgeSection.complete) {
          throw Object.assign(new Error(bridgeSection.reason ?? "bridge_incomplete"), {
            code: bridgeSection.reason ?? "bridge_incomplete",
          });
        }

        // SDK bootstrap section (idempotent double inject)
        const preSdk = await recheckHost(options.adapters, frozenHost);
        if (!preSdk.ok) {
          sdkSection = incompleteSdk(preSdk.reason);
          throw Object.assign(new Error(preSdk.reason), { code: preSdk.reason });
        }
        hostSnapshots.preSdk = preSdk.host;
        const first = await session.evaluate({
          executionContextId: selected.executionContextId,
          executionContextUniqueId: selected.executionContextUniqueId,
          expression: sdkBootstrapExpression(sdkSource!),
          signal: options.signal,
        });
        const second = await session.evaluate({
          executionContextId: selected.executionContextId,
          executionContextUniqueId: selected.executionContextUniqueId,
          expression: sdkBootstrapExpression(sdkSource!),
          signal: options.signal,
        });
        const firstRecord =
          typeof first.value === "object" && first.value !== null
            ? (first.value as Record<string, unknown>)
            : null;
        const secondRecord =
          typeof second.value === "object" && second.value !== null
            ? (second.value as Record<string, unknown>)
            : null;
        const firstVersion =
          typeof firstRecord?.after === "string" ? firstRecord.after : null;
        const secondVersion =
          typeof secondRecord?.after === "string" ? secondRecord.after : null;
        const singleInstance =
          firstVersion !== null &&
          secondVersion !== null &&
          firstVersion === secondVersion &&
          firstVersion === sdkRuntime!.version;
        sdkSection = {
          complete: singleInstance,
          sdkRuntime: sdkRuntime!,
          firstBootstrapVersion: firstVersion,
          secondBootstrapVersion: secondVersion,
          singleInstance,
          repeatCount: 2,
          reason: singleInstance ? null : "sdk_bootstrap_not_single_instance",
        };
        if (!sdkSection.complete) {
          throw Object.assign(new Error(sdkSection.reason ?? "sdk_bootstrap"), {
            code: sdkSection.reason ?? "sdk_bootstrap",
          });
        }

        // Anchor matrix
        const preAnchor = await recheckHost(options.adapters, frozenHost);
        if (!preAnchor.ok) {
          anchorsSection = incompleteAnchors(preAnchor.reason);
          throw Object.assign(new Error(preAnchor.reason), { code: preAnchor.reason });
        }
        hostSnapshots.preAnchor = preAnchor.host;
        const anchorEval = await session.evaluate({
          executionContextId: selected.executionContextId,
          executionContextUniqueId: selected.executionContextUniqueId,
          expression: ANCHOR_EVAL_EXPRESSION,
          signal: options.signal,
        });
        anchorsSection = parseAnchorMatrix(anchorEval.value);
        // Anchors may be pending; do not throw — assemble will mark pending.

        // Pre-persist host recheck
        const prePersist = await recheckHost(options.adapters, frozenHost);
        if (!prePersist.ok) {
          throw Object.assign(new Error(prePersist.reason), { code: prePersist.reason });
        }
        hostSnapshots.prePersist = prePersist.host;

        if (authoringMain !== null) {
          authoringSurvived = await runtimeProcess.isAlive(
            authoringMain.pid,
            authoringMain.processStartedAt,
            { abortSignal: options.signal },
          );
        }

        const safety: ProbeSafetySection = {
          complete: true,
          role: "development",
          port: 9444,
          hostReadOnly: true,
          conversationNondestructive:
            bridgeSection.conversationMutated === false &&
            bridgeSection.turnStarted === false &&
            bridgeSection.settingsChanged === false,
          isolated: true,
          devFirst: true,
          hostSnapshots,
          authoringMain: {
            pid: authoringMain?.pid ?? null,
            processStartedAt: authoringMain?.processStartedAt ?? null,
            survived: authoringSurvived,
          },
          credentialsInspected: false,
          reason: null,
        };

        const correlationIdentity: ProbeCorrelationIdentity = {
          operationId: identity.operationId,
          compatibilityKey: deriveCompatibilityKey({
            host: frozenHost,
            sdkRuntime: sdkRuntime!,
            probe: probeIdentity,
          }),
          frozenHost,
          pid: verified.pid,
          processStartedAt: verified.processStartedAt,
          port: 9444,
          targetId: selected.targetId,
          executionContextId: selected.executionContextId,
          executionContextUniqueId: selected.executionContextUniqueId,
          sdkRuntime: sdkRuntime!,
          probe: probeIdentity,
        };

        const probe = assembleCompatibilityProbeResult({
          identity: correlationIdentity,
          isolation,
          endpoint: endpointSection,
          bridge: bridgeSection,
          sdkBootstrap: sdkSection,
          anchors: anchorsSection,
          safety,
          clockIso: options.adapters.clock.nowIso(),
        });

        let committed = false;
        if (probe.allowsCompatibilityCommit && probe.status === "proven") {
          const record = buildCompatibilityRecordFromProbe(probe);
          await saveCompatibilityRecord({
            adapters: options.adapters,
            explodexHome: options.explodexHome,
            record,
          });
          committed = true;
        }

        return {
          ok: true as const,
          probe,
          committed,
          frozenHost,
        } satisfies CompatibilityProbeOperationResult;
      } catch (error: unknown) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { code: unknown }).code === "string"
            ? (error as { code: string }).code
            : "probe_failed";
        const message = error instanceof Error ? error.message : String(error);

        const safety: ProbeSafetySection = {
          complete: false,
          role: "development",
          port: 9444,
          hostReadOnly: true,
          conversationNondestructive: true,
          isolated: true,
          devFirst: true,
          hostSnapshots,
          authoringMain: {
            pid: authoringMain?.pid ?? null,
            processStartedAt: authoringMain?.processStartedAt ?? null,
            survived: authoringSurvived,
          },
          credentialsInspected: false,
          reason: message,
        };

        const correlationIdentity: ProbeCorrelationIdentity = {
          operationId: identity.operationId,
          compatibilityKey: deriveCompatibilityKey({
            host: frozenHost,
            sdkRuntime: sdkRuntime!,
            probe: probeIdentity,
          }),
          frozenHost,
          pid: options.acceptanceProcess.pid,
          processStartedAt: options.acceptanceProcess.processStartedAt,
          port: 9444,
          targetId: selected?.targetId ?? options.acceptanceProcess.targetId ?? "unknown",
          executionContextId:
            selected?.executionContextId ??
            options.acceptanceProcess.executionContextId ??
            -1,
          executionContextUniqueId:
            selected?.executionContextUniqueId ??
            options.acceptanceProcess.executionContextUniqueId ??
            "unknown",
          sdkRuntime: sdkRuntime!,
          probe: probeIdentity,
        };

        const probe = assembleCompatibilityProbeResult({
          identity: correlationIdentity,
          isolation,
          endpoint: endpointSection,
          bridge: bridgeSection,
          sdkBootstrap: sdkSection,
          anchors: anchorsSection,
          safety,
          clockIso: options.adapters.clock.nowIso(),
        });

        return {
          ok: false as const,
          probe,
          committed: false as const,
          frozenHost,
          error: { code, message },
        } satisfies CompatibilityProbeOperationResult;
      } finally {
        if (session !== null) {
          try {
            await session.close({ timeoutMs: 3_000 });
          } catch {
            // Residual session uncertainty is non-authorizing; probe already decided.
          }
        }
      }
    },
  );

  if (!lockResult.ok) {
    return {
      ok: false,
      probe: null,
      committed: false,
      frozenHost,
      error: {
        code: lockResult.code ?? "lock_failed",
        message: lockResult.message ?? "Unable to acquire dev-instance lock for probe",
      },
    };
  }

  return lockResult.value;
}

/** Pure helper for tests: build isolation section from a Phase 0 contract. */
export function isolationSectionFromPhase0(
  contract: Phase0LaunchContract | null,
): ProbeIsolationSection {
  if (contract === null) {
    return incompleteIsolation("phase0_missing");
  }
  if (contract.status !== "proven") {
    return incompleteIsolation(contract.reason ?? "phase0_not_proven");
  }
  if (contract.launchMarker === null || contract.retainedKnobs.length === 0) {
    return incompleteIsolation("phase0_isolation_incomplete");
  }
  return {
    complete: true,
    phase0Status: contract.status,
    retainedKnobs: [...contract.retainedKnobs],
    launchMarker: contract.launchMarker.value,
    isolation: contract.isolation,
    phase0FrozenHost: contract.frozenHost,
    reason: null,
  };
}
