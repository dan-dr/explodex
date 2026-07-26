/**
 * Construct the documented plugin API object for an accepted generation.
 */

import { SDK_VERSION } from "../version.ts";
import type { PluginApi, PluginLogger } from "../types/index.ts";
import type { TrackedResourceRegistry } from "./tracked-resources.ts";

export function createPluginApi(options: {
  pluginId: string;
  generation: number;
  token: string;
  resources: TrackedResourceRegistry;
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

  return {
    version: options.version ?? SDK_VERSION,
    pluginId: options.pluginId,
    generation: options.generation,
    token: options.token,
    log,
    track: options.resources.track,
  };
}
