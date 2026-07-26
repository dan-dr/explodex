import {
  ALLOWED_BRIDGE_TRANSPORTS,
  REQUIRED_BRIDGE_METHODS,
  type AllowedBridgeTransport,
  type ProbeBridgeSection,
  type ProbeConversationSurface,
  type RequiredBridgeMethod,
} from "./probe-types.ts";

export type { ProbeConversationSurface };

export type ParsedBridgeObservation = {
  transportAvailable: boolean;
  invokedTransport: AllowedBridgeTransport | null;
  requiredMethods: readonly RequiredBridgeMethod[];
  /** Methods factually observed on the exact renderer; never invented. */
  observedMethods: string[];
  benignRequest: string | null;
  benignResponse: unknown;
  beforeSurface: ProbeConversationSurface | null;
  afterSurface: ProbeConversationSurface | null;
  conversationMutated: boolean | null;
  turnStarted: boolean | null;
  settingsChanged: boolean | null;
  surfaceEvidenceComplete: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

function parseHints(
  value: unknown,
): Array<{ key: string; value: string }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ key: string; value: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.key !== "string" || typeof entry.value !== "string") return null;
    out.push({ key: entry.key, value: entry.value });
  }
  return out;
}

/** Parse one factual conversation/turn/settings surface observation. */
export function parseConversationSurface(
  value: unknown,
): ProbeConversationSurface | null {
  if (!isRecord(value)) return null;
  const conversationIds = parseStringArray(value.conversationIds);
  if (conversationIds === null) return null;
  const nextTurnHints = parseHints(value.nextTurnHints);
  if (nextTurnHints === null) return null;
  if (
    value.messageCount !== null &&
    value.messageCount !== undefined &&
    typeof value.messageCount !== "number"
  ) {
    return null;
  }
  if (
    value.composerValue !== null &&
    value.composerValue !== undefined &&
    typeof value.composerValue !== "string"
  ) {
    return null;
  }
  return {
    href: typeof value.href === "string" ? value.href : null,
    readyState: typeof value.readyState === "string" ? value.readyState : null,
    conversationIds,
    messageCount: typeof value.messageCount === "number" ? value.messageCount : null,
    composerValue: typeof value.composerValue === "string" ? value.composerValue : null,
    nextTurnHints,
  };
}

function stableSurfaceKey(surface: ProbeConversationSurface): string {
  return JSON.stringify({
    href: surface.href,
    readyState: surface.readyState,
    conversationIds: [...surface.conversationIds].sort(),
    messageCount: surface.messageCount,
    composerValue: surface.composerValue,
    nextTurnHints: surface.nextTurnHints
      .map((entry) => `${entry.key}=${entry.value}`)
      .sort(),
  });
}

/**
 * Derive factual nondestructive flags from before/after surface observations.
 * Missing or malformed evidence yields nulls and surfaceEvidenceComplete=false.
 */
export function deriveNondestructiveFromSurfaces(
  before: ProbeConversationSurface | null,
  after: ProbeConversationSurface | null,
): {
  conversationMutated: boolean | null;
  turnStarted: boolean | null;
  settingsChanged: boolean | null;
  surfaceEvidenceComplete: boolean;
  conversationNondestructive: boolean;
} {
  if (before === null || after === null) {
    return {
      conversationMutated: null,
      turnStarted: null,
      settingsChanged: null,
      surfaceEvidenceComplete: false,
      conversationNondestructive: false,
    };
  }
  if (before.messageCount === null || after.messageCount === null) {
    return {
      conversationMutated: null,
      turnStarted: null,
      settingsChanged: null,
      surfaceEvidenceComplete: false,
      conversationNondestructive: false,
    };
  }

  const beforeConversations = JSON.stringify([...before.conversationIds].sort());
  const afterConversations = JSON.stringify([...after.conversationIds].sort());
  const conversationMutated =
    beforeConversations !== afterConversations ||
    before.composerValue !== after.composerValue;

  const turnStarted = after.messageCount > before.messageCount;

  const beforeSettings = JSON.stringify(
    before.nextTurnHints.map((entry) => `${entry.key}=${entry.value}`).sort(),
  );
  const afterSettings = JSON.stringify(
    after.nextTurnHints.map((entry) => `${entry.key}=${entry.value}`).sort(),
  );
  const settingsChanged = beforeSettings !== afterSettings;

  // Full surface key equality is an additional integrity check.
  const surfacesEqual = stableSurfaceKey(before) === stableSurfaceKey(after);
  const conversationNondestructive =
    surfacesEqual && !conversationMutated && !turnStarted && !settingsChanged;

  return {
    conversationMutated,
    turnStarted,
    settingsChanged,
    surfaceEvidenceComplete: true,
    conversationNondestructive,
  };
}

/**
 * Required methods are recorded only when factually present in observedMethods.
 * Callers must never insert constants into observedMethods.
 */
export function factuallyObservedRequiredMethods(
  observedMethods: readonly string[],
): {
  observedRequired: RequiredBridgeMethod[];
  missingRequired: RequiredBridgeMethod[];
} {
  const observedRequired = REQUIRED_BRIDGE_METHODS.filter((method) =>
    observedMethods.includes(method),
  );
  const missingRequired = REQUIRED_BRIDGE_METHODS.filter(
    (method) => !observedMethods.includes(method),
  );
  return { observedRequired, missingRequired };
}

export function isAllowedBridgeTransport(
  value: unknown,
): value is AllowedBridgeTransport {
  return (
    typeof value === "string" &&
    (ALLOWED_BRIDGE_TRANSPORTS as readonly string[]).includes(value)
  );
}

/**
 * Validate one successful benign bridge response shape.
 * Availability-only, error, malformed, wrong-transport, and non-success remain incomplete.
 */
export function classifyBenignBridgeResponse(value: unknown): {
  ok: boolean;
  reason: string | null;
} {
  if (value === null || value === undefined) {
    return { ok: false, reason: "bridge_benign_response_missing" };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: "bridge_benign_response_malformed" };
  }
  const kind = value.kind;
  if (kind === "availability") {
    return { ok: false, reason: "bridge_availability_only" };
  }
  if (kind === "error") {
    return { ok: false, reason: "bridge_benign_response_error" };
  }
  if (kind === "wrong-transport") {
    return { ok: false, reason: "bridge_wrong_transport" };
  }
  if (kind === "theme") {
    // Theme helpers are not the exact-renderer bridge transport.
    return { ok: false, reason: "bridge_wrong_transport" };
  }
  if (kind !== "success") {
    return { ok: false, reason: "bridge_benign_response_non_success" };
  }
  if (!isAllowedBridgeTransport(value.transport)) {
    return { ok: false, reason: "bridge_wrong_transport" };
  }
  // success requires an explicit invoked flag or presence of value key.
  if (value.invoked !== true && !("value" in value)) {
    return { ok: false, reason: "bridge_benign_response_malformed" };
  }
  return { ok: true, reason: null };
}

/**
 * Build the incomplete bridge section when evaluation cannot authorize.
 * observedMethods retain only factual renderer observations.
 */
export function incompleteBridge(
  reason: string,
  partial?: Partial<
    Pick<
      ProbeBridgeSection,
      | "transportAvailable"
      | "invokedTransport"
      | "observedMethods"
      | "benignRequest"
      | "benignResponse"
      | "conversationMutated"
      | "turnStarted"
      | "settingsChanged"
      | "beforeSurface"
      | "afterSurface"
      | "surfaceEvidenceComplete"
    >
  >,
): ProbeBridgeSection {
  return {
    complete: false,
    transportAvailable: partial?.transportAvailable ?? false,
    invokedTransport: partial?.invokedTransport ?? null,
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods: partial?.observedMethods ?? [],
    benignRequest: partial?.benignRequest ?? null,
    benignResponse: partial?.benignResponse ?? null,
    conversationMutated: partial?.conversationMutated ?? null,
    turnStarted: partial?.turnStarted ?? null,
    settingsChanged: partial?.settingsChanged ?? null,
    beforeSurface: partial?.beforeSurface ?? null,
    afterSurface: partial?.afterSurface ?? null,
    surfaceEvidenceComplete: partial?.surfaceEvidenceComplete ?? false,
    reason,
  };
}

/** Parse a raw exact-renderer bridge evaluation into a typed section. */
export function parseBridgeValue(value: unknown): ProbeBridgeSection {
  if (!isRecord(value)) {
    return incompleteBridge("bridge_eval_malformed");
  }

  const transportAvailable = value.transportAvailable === true;
  const observedMethods = parseStringArray(value.observedMethods);
  if (observedMethods === null) {
    return incompleteBridge("bridge_observed_methods_malformed");
  }

  const { missingRequired } = factuallyObservedRequiredMethods(observedMethods);

  const beforeSurface = parseConversationSurface(value.beforeSurface);
  const afterSurface = parseConversationSurface(value.afterSurface);
  const derived = deriveNondestructiveFromSurfaces(beforeSurface, afterSurface);

  const conversationMutated = derived.conversationMutated;
  const turnStarted = derived.turnStarted;
  const settingsChanged = derived.settingsChanged;

  const benignRequest =
    typeof value.benignRequest === "string" ? value.benignRequest : null;
  const benignResponse =
    value.benignResponse === undefined ? null : value.benignResponse;

  const invokedTransport = isAllowedBridgeTransport(value.invokedTransport)
    ? value.invokedTransport
    : null;

  const partialBase = {
    observedMethods,
    benignRequest,
    benignResponse,
    beforeSurface,
    afterSurface,
    conversationMutated,
    turnStarted,
    settingsChanged,
    surfaceEvidenceComplete: derived.surfaceEvidenceComplete,
    invokedTransport,
  } as const;

  if (!transportAvailable) {
    return incompleteBridge("bridge_transport_unavailable", {
      ...partialBase,
      transportAvailable: false,
    });
  }

  if (missingRequired.length > 0) {
    return incompleteBridge(`bridge_methods_missing:${missingRequired.join(",")}`, {
      ...partialBase,
      transportAvailable: true,
    });
  }

  if (!derived.surfaceEvidenceComplete) {
    return incompleteBridge("bridge_surface_evidence_incomplete", {
      ...partialBase,
      transportAvailable: true,
      surfaceEvidenceComplete: false,
    });
  }

  if (
    conversationMutated === true ||
    turnStarted === true ||
    settingsChanged === true
  ) {
    return incompleteBridge("bridge_mutated_conversation", {
      ...partialBase,
      transportAvailable: true,
      surfaceEvidenceComplete: true,
    });
  }

  if (invokedTransport === null) {
    return incompleteBridge("bridge_transport_not_invoked", {
      ...partialBase,
      transportAvailable: true,
      surfaceEvidenceComplete: true,
    });
  }

  if (benignRequest === null || benignRequest.trim().length === 0) {
    return incompleteBridge("bridge_benign_request_missing", {
      ...partialBase,
      transportAvailable: true,
      surfaceEvidenceComplete: true,
    });
  }

  const responseClass = classifyBenignBridgeResponse(benignResponse);
  if (!responseClass.ok) {
    return incompleteBridge(responseClass.reason ?? "bridge_benign_response_invalid", {
      ...partialBase,
      transportAvailable: true,
      surfaceEvidenceComplete: true,
    });
  }

  // Response transport must match the recorded invoked transport.
  if (
    isRecord(benignResponse) &&
    typeof benignResponse.transport === "string" &&
    benignResponse.transport !== invokedTransport
  ) {
    return incompleteBridge("bridge_response_transport_mismatch", {
      ...partialBase,
      transportAvailable: true,
      surfaceEvidenceComplete: true,
    });
  }

  return {
    complete: true,
    transportAvailable: true,
    invokedTransport,
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods,
    benignRequest,
    benignResponse,
    conversationMutated: false,
    turnStarted: false,
    settingsChanged: false,
    beforeSurface,
    afterSurface,
    surfaceEvidenceComplete: true,
    reason: null,
  };
}

/**
 * Exact-renderer bridge evaluation expression.
 * - Required methods are recorded only when factually present in renderer sources.
 * - Nondestructive claims derive from factual before/after surface observations.
 * - Completes only after one successful benign request/response through an actually
 *   invoked exact-renderer bridge transport (appServerSend or sendMessageFromView).
 * - Availability-only, theme-only, error, and wrong-transport shapes never authorize.
 */
export function buildBridgeEvalExpression(): string {
  const required = JSON.stringify([...REQUIRED_BRIDGE_METHODS]);
  const allowed = JSON.stringify([...ALLOWED_BRIDGE_TRANSPORTS]);
  return `(async () => {
  const required = ${required};
  const allowedTransports = ${allowed};
  const appServer = globalThis.__explodexAppServerSend || globalThis.__bcAppServerSend;
  const electron = globalThis.electronBridge;
  const transportAvailable =
    typeof appServer === "function" ||
    typeof electron?.sendMessageFromView === "function";

  // Factually observe method names from renderer script text only. Never invent.
  const observed = [];
  try {
    const scripts = Array.from(document.scripts || []).map((s) => s.textContent || s.src || "");
    const blob = scripts.join("\\n");
    for (const method of required) {
      if (blob.includes(method)) observed.push(method);
    }
  } catch {}

  function observeSurface() {
    try {
      const conversationEls = document.querySelectorAll(
        "[data-conversation-id], [data-thread-id], [data-testid*='conversation'], [data-testid*='thread']",
      );
      const conversationIds = Array.from(conversationEls)
        .map((node) => {
          if (!(node instanceof Element)) return null;
          return (
            node.getAttribute("data-conversation-id") ||
            node.getAttribute("data-thread-id") ||
            node.getAttribute("data-testid") ||
            null
          );
        })
        .filter((value) => typeof value === "string" && value.length > 0);
      const messageEls = document.querySelectorAll(
        "[data-message-author-role], [data-message-id], [data-testid*='message']",
      );
      const composer = document.querySelector(
        '[data-testid="composer-input"], textarea, [contenteditable="true"]',
      );
      let composerValue = null;
      if (composer instanceof HTMLTextAreaElement) {
        composerValue = composer.value;
      } else if (composer instanceof HTMLElement) {
        composerValue = composer.textContent || "";
      }
      const hintNodes = document.querySelectorAll(
        "[data-effort], [data-model], [aria-label*='reasoning' i], [data-testid*='model'], [data-testid*='effort']",
      );
      const nextTurnHints = Array.from(hintNodes)
        .slice(0, 24)
        .map((node) => {
          if (!(node instanceof Element)) return null;
          const key =
            node.getAttribute("data-testid") ||
            node.getAttribute("aria-label") ||
            node.getAttribute("data-effort") ||
            node.getAttribute("data-model") ||
            node.tagName;
          const value = (node.textContent || "").trim().slice(0, 120);
          return { key: String(key), value: String(value) };
        })
        .filter((entry) => entry !== null);
      return {
        href: typeof location !== "undefined" && location.href ? location.href : null,
        readyState: document.readyState || null,
        conversationIds,
        messageCount: messageEls.length,
        composerValue,
        nextTurnHints,
      };
    } catch {
      return null;
    }
  }

  const beforeSurface = observeSurface();
  let invokedTransport = null;
  let benignRequest = null;
  let benignResponse = null;
  const requestType = "get-setting";
  const requestParams = { key: "__explodex.compat-probe.sentinel" };
  try {
    if (typeof appServer === "function") {
      invokedTransport = "appServerSend";
      benignRequest = JSON.stringify({
        transport: invokedTransport,
        type: requestType,
        params: requestParams,
      });
      const value = await appServer(requestType, { params: requestParams });
      benignResponse = {
        kind: "success",
        transport: invokedTransport,
        invoked: true,
        value: value === undefined ? null : value,
      };
    } else if (typeof electron?.sendMessageFromView === "function") {
      invokedTransport = "electronBridge.sendMessageFromView";
      const message = { type: requestType, params: requestParams };
      benignRequest = JSON.stringify({
        transport: invokedTransport,
        ...message,
      });
      const value = await electron.sendMessageFromView(message);
      benignResponse = {
        kind: "success",
        transport: invokedTransport,
        invoked: true,
        value: value === undefined ? null : value,
      };
    } else if (typeof electron?.getSystemThemeVariant === "function") {
      // Theme helper is not an exact-renderer bridge transport.
      benignRequest = "electronBridge.getSystemThemeVariant";
      benignResponse = {
        kind: "wrong-transport",
        attempted: "electronBridge.getSystemThemeVariant",
        value: electron.getSystemThemeVariant(),
      };
    } else {
      benignResponse = {
        kind: "availability",
        transportAvailable,
      };
    }
  } catch (err) {
    benignResponse = {
      kind: "error",
      transport: invokedTransport,
      message: String(err && err.message ? err.message : err),
    };
  }
  const afterSurface = observeSurface();

  return {
    transportAvailable,
    invokedTransport:
      invokedTransport && allowedTransports.includes(invokedTransport)
        ? invokedTransport
        : null,
    requiredMethods: required,
    observedMethods: observed,
    benignRequest,
    benignResponse,
    beforeSurface,
    afterSurface,
  };
})()`;
}

/**
 * Safety nondestructive claim is true only from complete factual surface evidence
 * that shows no conversation/turn/settings change around the benign request.
 */
export function conversationNondestructiveFromBridge(
  bridge: ProbeBridgeSection,
): boolean {
  if (!bridge.surfaceEvidenceComplete) return false;
  if (bridge.beforeSurface === null || bridge.afterSurface === null) return false;
  if (
    bridge.conversationMutated !== false ||
    bridge.turnStarted !== false ||
    bridge.settingsChanged !== false
  ) {
    return false;
  }
  if (bridge.invokedTransport === null || !bridge.complete) return false;
  return true;
}
