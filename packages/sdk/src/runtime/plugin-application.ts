import {
  createPluginAssetStore,
  createPluginLifecycleHost,
  createPrivateRegistrationController,
  type PluginAssetStore,
  type PluginLifecycleHost,
  type RegistrationHost,
} from "../lifecycle/index.ts";
import type {
  PluginReviewRequest,
  PluginUpdateReviewRequest,
  ReviewSubmission,
} from "./plugin-review.ts";

export const PRIVATE_APPLY_APPROVED =
  "__explodexApplyApprovedPayload" as const;
export const PRIVATE_FINALIZE_APPROVED =
  "__explodexFinalizeApprovedOperation" as const;
export const PRIVATE_RECONCILE_ENABLED =
  "__explodexReconcileEnabledPayload" as const;
export const PRIVATE_DISABLE_RECONCILIATION =
  "__explodexDisableEnabledReconciliation" as const;
export const PRIVATE_APPLICATION_STATUS =
  "__explodexPluginApplicationStatus" as const;
export const PRIVATE_UNLOAD_PLUGIN =
  "__explodexUnloadPlugin" as const;

type ApprovedAssetInput = {
  path: string;
  bytes: number[];
};

export type ApprovedPluginInput = {
  schemaVersion: 1;
  operationId: string;
  nonce: string;
  id: string;
  version: string;
  payloadSha256: string;
  lifecycle: "dynamic" | "renderer-start" | "app-start";
  boundary: "current" | "renderer" | "app";
  assets: ApprovedAssetInput[];
};

export type ApprovedPluginApplicationResult = {
  schemaVersion: 1;
  id: string;
  version: string;
  payloadSha256: string;
  status: "unchanged" | "applied" | "boundary-required" | "failed";
  boundary: "none" | "renderer" | "app";
  setupCount: number;
  previousAppliedIdentity: AppliedPluginIdentity | null;
  appliedIdentity: AppliedPluginIdentity | null;
  stage: "authorization" | "evaluation" | "setup" | "cleanup" | "none";
  possiblePartialEffects: boolean;
  error?: { code: string; message: string };
};

export type AppliedPluginIdentity = {
  id: string;
  version: string;
  payloadSha256: string;
};

export type PluginRuntimeDiagnostic = {
  id: string;
  identity: AppliedPluginIdentity;
  code: "plugin.runtime.error";
  message: string;
};

export type PluginApplicationController = {
  authorizeReview(
    request: PluginReviewRequest | PluginUpdateReviewRequest,
    submission: ReviewSubmission,
  ): void;
  applyApproved(
    input: unknown,
    evaluate: unknown,
    secret: unknown,
  ): Promise<ApprovedPluginApplicationResult>;
  reconcileEnabled(
    input: unknown,
    evaluate: unknown,
  ): Promise<ApprovedPluginApplicationResult>;
  claimEnabledReconciliation(): (
    (
      input: unknown,
      evaluate: unknown,
    ) => Promise<ApprovedPluginApplicationResult>
  ) | null;
  enableEnabledReconciliation(): void;
  disableEnabledReconciliation(): void;
  finalizeApproved(operationId: string, nonce: string): void;
  status(pluginId: string): {
    identity: AppliedPluginIdentity;
    lifecycle: ApprovedPluginInput["lifecycle"];
  } | null;
  reportRuntimeError(pluginId: string, error: unknown): void;
  unload(pluginId: string): ReturnType<PluginLifecycleHost["unload"]>;
  destroy(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeAssetPath(value: string): boolean {
  return value.startsWith("assets/") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== ".."
    );
}

function parseInput(value: unknown): ApprovedPluginInput | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    "assets",
    "boundary",
    "id",
    "lifecycle",
    "nonce",
    "operationId",
    "payloadSha256",
    "schemaVersion",
    "version",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    typeof value.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof value.payloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.payloadSha256) ||
    (value.lifecycle !== "dynamic" &&
      value.lifecycle !== "renderer-start" &&
      value.lifecycle !== "app-start") ||
    (value.boundary !== "current" &&
      value.boundary !== "renderer" &&
      value.boundary !== "app") ||
    !Array.isArray(value.assets)
  ) {
    return null;
  }
  const assets: ApprovedAssetInput[] = [];
  const seen = new Set<string>();
  for (const candidate of value.assets) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).sort().join(",") !== "bytes,path" ||
      typeof candidate.path !== "string" ||
      !isSafeAssetPath(candidate.path) ||
      seen.has(candidate.path) ||
      !Array.isArray(candidate.bytes) ||
      !candidate.bytes.every((byte) =>
        Number.isInteger(byte) && byte >= 0 && byte <= 255
      )
    ) {
      return null;
    }
    seen.add(candidate.path);
    assets.push({
      path: candidate.path,
      bytes: candidate.bytes.map(Number),
    });
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    nonce: value.nonce,
    id: value.id,
    version: value.version,
    payloadSha256: value.payloadSha256,
    lifecycle: value.lifecycle,
    boundary: value.boundary,
    assets,
  };
}

function failed(
  input: ApprovedPluginInput,
  code: string,
  message: string,
  options?: {
    previousAppliedIdentity?: AppliedPluginIdentity | null;
    appliedIdentity?: AppliedPluginIdentity | null;
    stage?: ApprovedPluginApplicationResult["stage"];
    setupCount?: number;
    possiblePartialEffects?: boolean;
  },
): ApprovedPluginApplicationResult {
  return {
    schemaVersion: 1,
    id: input.id,
    version: input.version,
    payloadSha256: input.payloadSha256,
    status: "failed",
    boundary: "none",
    setupCount: options?.setupCount ?? 0,
    previousAppliedIdentity: options?.previousAppliedIdentity ?? null,
    appliedIdentity: options?.appliedIdentity ?? null,
    stage: options?.stage ?? "authorization",
    possiblePartialEffects: options?.possiblePartialEffects ?? false,
    error: { code, message },
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createPluginApplicationController(options: {
  host: RegistrationHost;
  onDiagnostic?(diagnostic: PluginRuntimeDiagnostic): void;
}): PluginApplicationController {
  const registration = createPrivateRegistrationController(options.host);
  const live = new Map<string, {
    identity: AppliedPluginIdentity;
    lifecycle: ApprovedPluginInput["lifecycle"];
    store: PluginAssetStore;
    generation: number;
    token: string;
  }>();
  const generationIdentities = new Map<number, {
    token: string;
    identity: AppliedPluginIdentity;
  }>();
  const pendingDiagnostics = new Map<number, unknown[]>();
  const reportDiagnostic = (
    pluginId: string,
    identity: AppliedPluginIdentity,
    error: unknown,
  ) => {
    options.onDiagnostic?.({
      id: pluginId,
      identity: { ...identity },
      code: "plugin.runtime.error",
      message: error instanceof Error
        ? error.message
        : "Plugin emitted a delayed runtime error.",
    });
  };
  const bindGenerationIdentity = (
    pluginId: string,
    generation: number,
    token: string,
    identity: AppliedPluginIdentity,
  ) => {
    generationIdentities.set(generation, { token, identity: { ...identity } });
    for (const error of pendingDiagnostics.get(generation) ?? []) {
      reportDiagnostic(pluginId, identity, error);
    }
    pendingDiagnostics.delete(generation);
  };
  const lifecycle = createPluginLifecycleHost({
    onRuntimeError(event) {
      const origin = generationIdentities.get(event.generation);
      if (origin !== undefined && origin.token === event.token) {
        reportDiagnostic(event.pluginId, origin.identity, event.error);
        return;
      }
      const pending = pendingDiagnostics.get(event.generation) ?? [];
      pending.push(event.error);
      pendingDiagnostics.set(event.generation, pending);
    },
  });
  const pending = new Map<string, {
    activationCommitment: string;
    activateByMs: number;
    applicationTtlMs: number;
    applicationExpiresAtMs: number | null;
    allowedBoundary: ApprovedPluginInput["boundary"];
    selected: Set<string>;
  }>();
  let enabledReconciliationAvailable = true;
  const grantKey = (operationId: string, nonce: string): string =>
    `${operationId}\0${nonce}`;
  const identityKey = (input: {
    id: string;
    version: string;
    payloadSha256: string;
  }): string => `${input.id}\0${input.version}\0${input.payloadSha256}`;
  const copyIdentity = (
    identity: AppliedPluginIdentity | null,
  ): AppliedPluginIdentity | null =>
    identity === null ? null : { ...identity };

  const controller: PluginApplicationController = {
    authorizeReview(request, submission) {
      enabledReconciliationAvailable = false;
      const remaining = new Set(submission.selected.map(identityKey));
      if (remaining.size === 0) {
        const key = grantKey(request.operationId, request.nonce);
        pending.delete(key);
        return;
      }
      pending.set(grantKey(request.operationId, request.nonce), {
        activationCommitment: request.activationCommitment,
        activateByMs: Date.now() + request.applicationTtlMs * 4,
        applicationTtlMs: request.applicationTtlMs,
        applicationExpiresAtMs: null,
        allowedBoundary: "current",
        selected: remaining,
      });
    },
    async applyApproved(raw, evaluate, secret) {
      const input = parseInput(raw);
      if (input === null) {
        return {
          schemaVersion: 1,
          id: "invalid",
          version: "invalid",
          payloadSha256: "0".repeat(64),
          status: "failed",
          boundary: "none",
          setupCount: 0,
          previousAppliedIdentity: null,
          appliedIdentity: null,
          stage: "authorization",
          possiblePartialEffects: false,
          error: {
            code: "plugin.application.invalid-input",
            message: "Approved plugin application input was malformed.",
          },
        };
      }
      const key = grantKey(input.operationId, input.nonce);
      const grant = pending.get(key);
      const identity = identityKey(input);
      const previous = live.get(input.id);
      const previousIdentity = copyIdentity(previous?.identity ?? null);
      if (grant === undefined || Date.now() >= grant.activateByMs) {
        pending.delete(key);
        return failed(
          input,
          "plugin.application.unauthorized",
          "Approved plugin application capability was absent, expired, or already consumed.",
          {
            previousAppliedIdentity: previousIdentity,
            appliedIdentity: previousIdentity,
          },
        );
      }
      if (
        typeof secret !== "string" ||
        !/^[a-f0-9]{64}$/u.test(secret) ||
        await sha256(secret) !== grant.activationCommitment ||
        pending.get(key) !== grant
      ) {
        return failed(
          input,
          "plugin.application.unauthorized",
          "Approved plugin application capability secret was invalid.",
          {
            previousAppliedIdentity: previousIdentity,
            appliedIdentity: previousIdentity,
          },
        );
      }
      if (input.boundary !== grant.allowedBoundary) {
        return failed(
          input,
          "plugin.application.wrong-boundary",
          "Plugin application capability was not issued for this lifecycle boundary.",
          {
            previousAppliedIdentity: previousIdentity,
            appliedIdentity: previousIdentity,
          },
        );
      }
      if (grant.applicationExpiresAtMs === null) {
        grant.applicationExpiresAtMs = Date.now() + grant.applicationTtlMs;
      }
      if (
        Date.now() >= grant.applicationExpiresAtMs ||
        !grant.selected.delete(identity)
      ) {
        pending.delete(key);
        return failed(
          input,
          "plugin.application.unauthorized",
          "Approved plugin application capability was absent, expired, or already consumed.",
          {
            previousAppliedIdentity: previousIdentity,
            appliedIdentity: previousIdentity,
          },
        );
      }
      if (grant.selected.size === 0) pending.delete(key);
      const boundarySatisfied =
        input.lifecycle === "dynamic" ||
        (input.lifecycle === "renderer-start" &&
          (input.boundary === "renderer" || input.boundary === "app")) ||
        (input.lifecycle === "app-start" && input.boundary === "app");
      if (!boundarySatisfied) {
        return {
          schemaVersion: 1,
          id: input.id,
          version: input.version,
          payloadSha256: input.payloadSha256,
          status: "boundary-required",
          boundary: input.lifecycle === "renderer-start" ? "renderer" : "app",
          setupCount: 0,
          previousAppliedIdentity: previousIdentity,
          appliedIdentity: previousIdentity,
          stage: "none",
          possiblePartialEffects: false,
        };
      }
      const requestedIdentity: AppliedPluginIdentity = {
        id: input.id,
        version: input.version,
        payloadSha256: input.payloadSha256,
      };
      if (
        previous !== undefined &&
        identityKey(previous.identity) === identityKey(requestedIdentity)
      ) {
        return {
          schemaVersion: 1,
          ...requestedIdentity,
          status: "unchanged",
          boundary: "none",
          setupCount: 0,
          previousAppliedIdentity: copyIdentity(previous.identity),
          appliedIdentity: copyIdentity(previous.identity),
          stage: "none",
          possiblePartialEffects: false,
        };
      }
      if (typeof evaluate !== "function") {
        return failed(
          input,
          "plugin.application.invalid-source",
          "Dynamic approved plugin application requires one source evaluator.",
          {
            previousAppliedIdentity: previousIdentity,
            appliedIdentity: previousIdentity,
            stage: "evaluation",
          },
        );
      }

      const registered = registration.evaluateInert({
        expectedPluginId: input.id,
        evaluate: evaluate as () => void,
      });
      if (!registered.ok) {
        return failed(input, registered.code, registered.message, {
          previousAppliedIdentity: previousIdentity,
          appliedIdentity: previousIdentity,
          stage: "evaluation",
          possiblePartialEffects: true,
        });
      }

      const store = createPluginAssetStore({
        pluginId: input.id,
        assets: new Map(
          input.assets.map((asset) => [
            asset.path,
            Uint8Array.from(asset.bytes),
          ]),
        ),
      });
      const applied = await lifecycle.apply({
        pluginId: input.id,
        definition: registered.registration.definition,
        assets: store,
      });
      if (!applied.ok) {
        const newGenerationIsLive = applied.record.status === "applied";
        if (!newGenerationIsLive) store.revoke();
        if (newGenerationIsLive) {
          live.set(input.id, {
            identity: requestedIdentity,
            lifecycle: input.lifecycle,
            store,
            generation: applied.record.generation,
            token: applied.record.token,
          });
          bindGenerationIdentity(
            input.id,
            applied.record.generation,
            applied.record.token,
            requestedIdentity,
          );
          previous?.store.revoke();
        }
        return {
          schemaVersion: 1,
          id: input.id,
          version: input.version,
          payloadSha256: input.payloadSha256,
          status: newGenerationIsLive ? "applied" : "failed",
          boundary: "none",
          setupCount: applied.record.setupCount,
          previousAppliedIdentity: previousIdentity,
          appliedIdentity: newGenerationIsLive
            ? copyIdentity(requestedIdentity)
            : previousIdentity,
          stage: newGenerationIsLive ? "cleanup" : "setup",
          possiblePartialEffects: applied.record.setupCount > 0,
          error: { code: applied.code, message: applied.message },
        };
      }
      live.set(input.id, {
        identity: requestedIdentity,
        lifecycle: input.lifecycle,
        store,
        generation: applied.record.generation,
        token: applied.record.token,
      });
      bindGenerationIdentity(
        input.id,
        applied.record.generation,
        applied.record.token,
        requestedIdentity,
      );
      previous?.store.revoke();
      return {
        schemaVersion: 1,
        id: input.id,
        version: input.version,
        payloadSha256: input.payloadSha256,
        status: "applied",
        boundary: "none",
        setupCount: applied.record.setupCount,
        previousAppliedIdentity: previousIdentity,
        appliedIdentity: copyIdentity(requestedIdentity),
        stage: "setup",
        possiblePartialEffects: false,
      };
    },
    async reconcileEnabled(raw, evaluate) {
      const input = parseInput(raw);
      if (input === null) {
        return {
          schemaVersion: 1,
          id: "invalid",
          version: "invalid",
          payloadSha256: "0".repeat(64),
          status: "failed",
          boundary: "none",
          setupCount: 0,
          previousAppliedIdentity: null,
          appliedIdentity: null,
          stage: "authorization",
          possiblePartialEffects: false,
          error: {
            code: "plugin.application.invalid-input",
            message: "Enabled plugin reconciliation input was malformed.",
          },
        };
      }
      const activationCapability = input.payloadSha256;
      pending.set(grantKey(input.operationId, input.nonce), {
        activationCommitment: await sha256(activationCapability),
        activateByMs: Date.now() + 60_000,
        applicationTtlMs: 60_000,
        applicationExpiresAtMs: null,
        allowedBoundary: input.boundary,
        selected: new Set([identityKey(input)]),
      });
      return controller.applyApproved(input, evaluate, activationCapability);
    },
    claimEnabledReconciliation() {
      if (!enabledReconciliationAvailable) return null;
      enabledReconciliationAvailable = false;
      let operationId: string | null = null;
      let nonce: string | null = null;
      const consumed = new Set<string>();
      return (input, evaluate) => {
        const parsed = parseInput(input);
        if (
          parsed === null ||
          (
            operationId !== null &&
            (
              parsed.operationId !== operationId ||
              parsed.nonce !== nonce
            )
          ) ||
          consumed.has(identityKey(parsed))
        ) {
          return Promise.resolve(failed(
            {
              schemaVersion: 1,
              operationId: "consumed",
              nonce: "consumed",
              id: "invalid",
              version: "invalid",
              payloadSha256: "0".repeat(64),
              lifecycle: "dynamic",
              boundary: "current",
              assets: [],
            },
            "plugin.application.unauthorized",
            "Enabled reconciliation capability was malformed, cross-operation, or replayed.",
          ));
        }
        operationId ??= parsed.operationId;
        nonce ??= parsed.nonce;
        consumed.add(identityKey(parsed));
        return controller.reconcileEnabled(input, evaluate);
      };
    },
    enableEnabledReconciliation() {
      enabledReconciliationAvailable = true;
    },
    disableEnabledReconciliation() {
      enabledReconciliationAvailable = false;
    },
    finalizeApproved(operationId, nonce) {
      enabledReconciliationAvailable = false;
      const key = grantKey(operationId, nonce);
      pending.delete(key);
    },
    status(pluginId) {
      const current = live.get(pluginId);
      return current === undefined
        ? null
        : {
            identity: { ...current.identity },
            lifecycle: current.lifecycle,
          };
    },
    reportRuntimeError(pluginId, error) {
      const current = live.get(pluginId);
      if (current === undefined) return;
      options.onDiagnostic?.({
        id: pluginId,
        identity: { ...current.identity },
        code: "plugin.runtime.error",
        message: error instanceof Error
          ? error.message
          : "Plugin emitted a delayed runtime error.",
      });
    },
    unload(pluginId) {
      live.get(pluginId)?.store.revoke();
      live.delete(pluginId);
      return lifecycle.unload({ pluginId });
    },
    async destroy() {
      pending.clear();
      generationIdentities.clear();
      pendingDiagnostics.clear();
      const ids = lifecycle.list().map((record) => record.pluginId);
      for (const id of ids.reverse()) {
        live.get(id)?.store.revoke();
        live.delete(id);
        await lifecycle.unload({ pluginId: id });
      }
    },
  };
  return controller;
}
