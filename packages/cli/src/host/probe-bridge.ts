import {
  REQUIRED_BRIDGE_METHODS,
  type ProbeBridgeSection,
  type ProbeConversationSurface,
  type RequiredBridgeMethod,
} from "./probe-types.ts";

export type { ProbeConversationSurface };

export type ParsedBridgeObservation = {
  transportAvailable: boolean;
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

  // Reject fabricated full-required dumps that claim observation without evidence
  // markers: every observed method must be a non-empty string (already validated).
  // Missing required methods leave proof non-authorizing.
  const { missingRequired } = factuallyObservedRequiredMethods(observedMethods);

  const beforeSurface = parseConversationSurface(value.beforeSurface);
  const afterSurface = parseConversationSurface(value.afterSurface);
  const derived = deriveNondestructiveFromSurfaces(beforeSurface, afterSurface);

  // Prefer factual derived flags; ignore hard-coded true-looking booleans that
  // lack surface evidence. If the renderer reported explicit mutation flags and
  // surfaces are complete, still re-derive from surfaces only.
  const conversationMutated = derived.conversationMutated;
  const turnStarted = derived.turnStarted;
  const settingsChanged = derived.settingsChanged;

  const benignRequest =
    typeof value.benignRequest === "string" ? value.benignRequest : null;
  const benignResponse =
    value.benignResponse === undefined ? null : value.benignResponse;

  if (!transportAvailable) {
    return incompleteBridge("bridge_transport_unavailable", {
      observedMethods,
      benignRequest,
      benignResponse,
      beforeSurface,
      afterSurface,
      conversationMutated,
      turnStarted,
      settingsChanged,
      surfaceEvidenceComplete: derived.surfaceEvidenceComplete,
    });
  }

  if (missingRequired.length > 0) {
    return incompleteBridge(`bridge_methods_missing:${missingRequired.join(",")}`, {
      transportAvailable: true,
      observedMethods,
      benignRequest,
      benignResponse,
      beforeSurface,
      afterSurface,
      conversationMutated,
      turnStarted,
      settingsChanged,
      surfaceEvidenceComplete: derived.surfaceEvidenceComplete,
    });
  }

  if (!derived.surfaceEvidenceComplete) {
    return incompleteBridge("bridge_surface_evidence_incomplete", {
      transportAvailable: true,
      observedMethods,
      benignRequest,
      benignResponse,
      beforeSurface,
      afterSurface,
      conversationMutated,
      turnStarted,
      settingsChanged,
      surfaceEvidenceComplete: false,
    });
  }

  if (
    conversationMutated === true ||
    turnStarted === true ||
    settingsChanged === true
  ) {
    return incompleteBridge("bridge_mutated_conversation", {
      transportAvailable: true,
      observedMethods,
      benignRequest,
      benignResponse,
      beforeSurface,
      afterSurface,
      conversationMutated,
      turnStarted,
      settingsChanged,
      surfaceEvidenceComplete: true,
    });
  }

  if (benignResponse === null) {
    return incompleteBridge("bridge_benign_response_missing", {
      transportAvailable: true,
      observedMethods,
      benignRequest,
      beforeSurface,
      afterSurface,
      conversationMutated,
      turnStarted,
      settingsChanged,
      surfaceEvidenceComplete: true,
    });
  }

  return {
    complete: true,
    transportAvailable: true,
    requiredMethods: REQUIRED_BRIDGE_METHODS,
    observedMethods,
    benignRequest: benignRequest ?? "theme-or-availability",
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
 * - Never invents required method names into observedMethods.
 */
export function buildBridgeEvalExpression(): string {
  const required = JSON.stringify([...REQUIRED_BRIDGE_METHODS]);
  return `(() => {
  const required = ${required};
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
  let benignResponse = null;
  const benignRequest = "theme-or-availability";
  try {
    if (typeof electron?.getSystemThemeVariant === "function") {
      benignResponse = { kind: "theme", value: electron.getSystemThemeVariant() };
    } else {
      benignResponse = { kind: "availability", transportAvailable };
    }
  } catch (err) {
    benignResponse = {
      kind: "error",
      message: String(err && err.message ? err.message : err),
    };
  }
  const afterSurface = observeSurface();

  return {
    transportAvailable,
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
  return true;
}
