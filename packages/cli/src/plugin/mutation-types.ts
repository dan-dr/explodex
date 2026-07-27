import type { RuntimeAdapters } from "../runtime/adapters.ts";
import type { ResidualLockAuthority } from "../runtime/locks.ts";
import type { PluginsState } from "./install-state.ts";
import type {
  PluginApplicationObservation,
  PluginMutationResult,
} from "./reconciliation.ts";

export type PluginMutationIdentity = {
  version: string;
  payloadSha256: string;
};

export type PluginTeardownRequest = {
  id: string;
  identity: PluginMutationIdentity;
  lifecycle: "dynamic";
};

export type PluginTeardownResult = Pick<
  PluginApplicationObservation,
  "status" | "target" | "appliedIdentity" | "message" | "error"
>;

export type PluginMutationAdapters = {
  writeState(options: {
    explodexHome: string;
    state: PluginsState;
  }): Promise<void>;
  deleteArtifact(path: string): Promise<void>;
};

export type PluginDisableOptions = {
  explodexHome: string;
  id: string;
  now?: () => string;
  signal?: AbortSignal;
  operationId?: string;
  lockWaitMs?: number;
  runtimeAdapters?: RuntimeAdapters;
  teardown?(request: PluginTeardownRequest): Promise<PluginTeardownResult>;
  adapters?: Partial<PluginMutationAdapters>;
};

export type PluginDisableResult =
  | {
      ok: true;
      operationId: string;
      stateCommitted: boolean;
      authorityChanged: boolean;
      mutation: PluginMutationResult;
      residualLockAuthority?: ResidualLockAuthority;
    }
  | {
      ok: false;
      operationId: string;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      stateCommitted: boolean;
      authorityChanged: boolean;
      mutation: PluginMutationResult | null;
      residualLockAuthority?: ResidualLockAuthority;
    };

export type PluginRemoveOptions = {
  explodexHome: string;
  id: string;
  identity?: PluginMutationIdentity;
  now?: () => string;
  signal?: AbortSignal;
  operationId?: string;
  lockWaitMs?: number;
  runtimeAdapters?: RuntimeAdapters;
  teardown?(request: PluginTeardownRequest): Promise<PluginTeardownResult>;
  adapters?: Partial<PluginMutationAdapters>;
};

export type PluginRemoveResult =
  | {
      ok: true;
      operationId: string;
      removed: { id: string } & PluginMutationIdentity;
      stateCommitted: boolean;
      authorityChanged: boolean;
      artifactDeleted: boolean;
      orphanedDirectory: null;
      mutation: PluginMutationResult;
      residualLockAuthority?: ResidualLockAuthority;
    }
  | {
      ok: false;
      operationId: string;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      removed: ({ id: string } & PluginMutationIdentity) | null;
      stateCommitted: boolean;
      authorityChanged: boolean;
      artifactDeleted: boolean;
      orphanedDirectory: string | null;
      mutation: PluginMutationResult | null;
      residualLockAuthority?: ResidualLockAuthority;
    };
