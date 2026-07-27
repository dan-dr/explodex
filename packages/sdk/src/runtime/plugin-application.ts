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
  ReviewSubmission,
} from "./plugin-review.ts";

export const PRIVATE_APPLY_APPROVED =
  "__explodexApplyApprovedPayload" as const;
export const PRIVATE_FINALIZE_APPROVED =
  "__explodexFinalizeApprovedOperation" as const;

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
  assets: ApprovedAssetInput[];
};

export type ApprovedPluginApplicationResult = {
  schemaVersion: 1;
  id: string;
  version: string;
  payloadSha256: string;
  status: "applied" | "boundary-required" | "failed";
  boundary: "none" | "renderer" | "app";
  setupCount: number;
  error?: { code: string; message: string };
};

export type PluginApplicationController = {
  authorizeReview(
    request: PluginReviewRequest,
    submission: ReviewSubmission,
  ): void;
  applyApproved(
    input: unknown,
    evaluate: unknown,
    secret: unknown,
  ): Promise<ApprovedPluginApplicationResult>;
  finalizeApproved(operationId: string, nonce: string): void;
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
    assets,
  };
}

function failed(
  input: ApprovedPluginInput,
  code: string,
  message: string,
): ApprovedPluginApplicationResult {
  return {
    schemaVersion: 1,
    id: input.id,
    version: input.version,
    payloadSha256: input.payloadSha256,
    status: "failed",
    boundary: "none",
    setupCount: 0,
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
}): PluginApplicationController {
  const lifecycle = createPluginLifecycleHost();
  const registration = createPrivateRegistrationController(options.host);
  const stores = new Map<string, PluginAssetStore>();
  const pending = new Map<string, {
    activationCommitment: string;
    activateByMs: number;
    applicationTtlMs: number;
    applicationExpiresAtMs: number | null;
    selected: Set<string>;
  }>();
  const grantKey = (operationId: string, nonce: string): string =>
    `${operationId}\0${nonce}`;
  const identityKey = (input: {
    id: string;
    version: string;
    payloadSha256: string;
  }): string => `${input.id}\0${input.version}\0${input.payloadSha256}`;

  return {
    authorizeReview(request, submission) {
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
          error: {
            code: "plugin.application.invalid-input",
            message: "Approved plugin application input was malformed.",
          },
        };
      }
      const key = grantKey(input.operationId, input.nonce);
      const grant = pending.get(key);
      const identity = identityKey(input);
      if (grant === undefined || Date.now() >= grant.activateByMs) {
        pending.delete(key);
        return failed(
          input,
          "plugin.application.unauthorized",
          "Approved plugin application capability was absent, expired, or already consumed.",
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
        );
      }
      if (grant.selected.size === 0) pending.delete(key);
      if (input.lifecycle !== "dynamic") {
        return {
          schemaVersion: 1,
          id: input.id,
          version: input.version,
          payloadSha256: input.payloadSha256,
          status: "boundary-required",
          boundary: input.lifecycle === "renderer-start" ? "renderer" : "app",
          setupCount: 0,
        };
      }
      if (typeof evaluate !== "function") {
        return failed(
          input,
          "plugin.application.invalid-source",
          "Dynamic approved plugin application requires one source evaluator.",
        );
      }

      const registered = registration.evaluateInert({
        expectedPluginId: input.id,
        evaluate: evaluate as () => void,
      });
      if (!registered.ok) {
        return failed(input, registered.code, registered.message);
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
      const previous = stores.get(input.id);
      const applied = await lifecycle.apply({
        pluginId: input.id,
        definition: registered.registration.definition,
        assets: store,
      });
      if (!applied.ok) {
        store.revoke();
        return {
          schemaVersion: 1,
          id: input.id,
          version: input.version,
          payloadSha256: input.payloadSha256,
          status: "failed",
          boundary: "none",
          setupCount: applied.record.setupCount,
          error: { code: applied.code, message: applied.message },
        };
      }
      stores.set(input.id, store);
      previous?.revoke();
      return {
        schemaVersion: 1,
        id: input.id,
        version: input.version,
        payloadSha256: input.payloadSha256,
        status: "applied",
        boundary: "none",
        setupCount: applied.record.setupCount,
      };
    },
    finalizeApproved(operationId, nonce) {
      const key = grantKey(operationId, nonce);
      pending.delete(key);
    },
    unload(pluginId) {
      stores.get(pluginId)?.revoke();
      stores.delete(pluginId);
      return lifecycle.unload({ pluginId });
    },
    async destroy() {
      pending.clear();
      const ids = lifecycle.list().map((record) => record.pluginId);
      for (const id of ids.reverse()) {
        stores.get(id)?.revoke();
        stores.delete(id);
        await lifecycle.unload({ pluginId: id });
      }
    },
  };
}
