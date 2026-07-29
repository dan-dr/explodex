/**
 * Construct the documented plugin API object for an accepted generation.
 */

import { SDK_VERSION } from "../version.ts";
import type { PluginApi, PluginLogger } from "../types/index.ts";
import type { PluginAssetStore } from "./plugin-assets.ts";
import { createPluginCapabilities } from "./plugin-capabilities.ts";
import type { TrackedResourceRegistry } from "./tracked-resources.ts";

export function createPluginApi(options: {
  pluginId: string;
  generation: number;
  token: string;
  resources: TrackedResourceRegistry;
  assets?: PluginAssetStore;
  host?: Record<string, unknown>;
  log?: PluginLogger;
  version?: string;
}): PluginApi {
  const log: PluginLogger = options.log ?? {
    debug(message, detail) {
      if (detail !== undefined) console.debug(`[explodex:${options.pluginId}]`, message, detail);
      else console.debug(`[explodex:${options.pluginId}]`, message);
    },
    info(message, detail) {
      if (detail !== undefined) console.info(`[explodex:${options.pluginId}]`, message, detail);
      else console.info(`[explodex:${options.pluginId}]`, message);
    },
    warn(message, detail) {
      if (detail !== undefined) console.warn(`[explodex:${options.pluginId}]`, message, detail);
      else console.warn(`[explodex:${options.pluginId}]`, message);
    },
    error(message, detail) {
      if (detail !== undefined) console.error(`[explodex:${options.pluginId}]`, message, detail);
      else console.error(`[explodex:${options.pluginId}]`, message);
    },
  };
  const assets = options.assets === undefined
    ? {
        open(path: string) {
          return Promise.reject(
            new Error(
              `Asset delivery is unavailable in this lifecycle host: ${path}`,
            ),
          );
        },
      }
    : {
        async open(path: string) {
          const handle = await options.assets!.open(path);
          try {
            options.resources.track.asset(handle);
          } catch (error: unknown) {
            handle.revoke();
            throw error;
          }
          return handle;
        },
      };

  const capabilities = createPluginCapabilities({
    host: options.host,
    pluginId: options.pluginId,
    ownerKey: `${options.pluginId}:${options.token}`,
    resources: options.resources,
    log,
  });

  return {
    ...capabilities,
    version: options.version ?? SDK_VERSION,
    pluginId: options.pluginId,
    generation: options.generation,
    token: options.token,
    log,
    track: options.resources.track,
    assets,
  };
}
