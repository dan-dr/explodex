/**
 * Plugin-scoped asset delivery backed only by accepted in-memory payload bytes.
 * The store and every opened handle are revocable runtime-tracked resources.
 */

import type { PluginAssetHandle, PluginAssets } from "../types/plugin.ts";

export type RevocablePluginAssetHandle = PluginAssetHandle & {
  revoke(): void;
};

export type PluginAssetStore = Omit<PluginAssets, "open"> & {
  open(path: string): Promise<RevocablePluginAssetHandle>;
  revoke(): void;
};

function assetRequestFailure(): Error {
  return new Error(
    "Plugin asset request was invalid, undeclared, unavailable, or revoked.",
  );
}

function normalizeRequestPath(value: string): string | null {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("assets/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  const parts = value.split("/");
  if (
    parts.some((part) =>
      part.length === 0 || part === "." || part === ".."
    )
  ) {
    return null;
  }
  return parts.join("/");
}

function normalizeStoredPath(value: string): string | null {
  if (!value.startsWith("assets/")) return null;
  const relative = normalizeRequestPath(value.slice("assets/".length));
  return relative === null ? null : `assets/${relative}`;
}

export function createPluginAssetStore(options: {
  pluginId: string;
  assets: ReadonlyMap<string, Uint8Array>;
}): PluginAssetStore {
  if (options.pluginId.length === 0) {
    throw new Error("Plugin asset store requires a non-empty plugin ID.");
  }
  const accepted = new Map<string, Uint8Array>();
  for (const [path, bytes] of options.assets) {
    const normalized = normalizeStoredPath(path);
    if (normalized === null || normalized !== path) {
      throw new Error("Plugin asset store received an invalid declared path.");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("Plugin asset store received invalid asset bytes.");
    }
    accepted.set(path, new Uint8Array(bytes));
  }

  let revoked = false;
  const handles = new Set<RevocablePluginAssetHandle>();

  const store: PluginAssetStore = {
    async open(requestPath) {
      if (revoked) throw assetRequestFailure();
      const normalized = normalizeRequestPath(requestPath);
      if (normalized === null) throw assetRequestFailure();
      const bytes = accepted.get(`assets/${normalized}`);
      if (bytes === undefined) throw assetRequestFailure();

      let handleRevoked = false;
      const assertReadable = (): void => {
        if (revoked || handleRevoked) {
          throw new Error("Plugin asset handle has been revoked.");
        }
      };
      const handle: RevocablePluginAssetHandle = Object.freeze({
        path: normalized,
        async text() {
          assertReadable();
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        },
        async bytes() {
          assertReadable();
          return new Uint8Array(bytes);
        },
        revoke() {
          if (handleRevoked) return;
          handleRevoked = true;
          handles.delete(handle);
        },
      });
      handles.add(handle);
      return handle;
    },
    revoke() {
      if (revoked) return;
      revoked = true;
      for (const handle of [...handles]) handle.revoke();
      handles.clear();
      accepted.clear();
    },
  };
  return Object.freeze(store);
}
