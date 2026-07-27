import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { discoverInstalledPlugins } from "../plugin/discovery.ts";
import {
  listPluginUpdateRecommendations,
  type PluginUpdateMetadata,
} from "../plugin/update-transaction.ts";
import {
  loadPluginUpdateRecommendations,
} from "../plugin/update-source.ts";

const OPERATION = "plugin.update.check";

export async function runPluginUpdateCheck(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const tokens = [...options.rest, ...options.endOfOptions];
  if (tokens.length > 0) {
    return usageFailure({
      operation: OPERATION,
      code: tokens[0]?.startsWith("-")
        ? "usage.unknown-option"
        : "usage.invalid-value",
      message: `Unexpected argument or option '${tokens[0]}'.`,
      usageLine: "Usage: explodex plugin update check",
      helpPath: "plugin update check",
    });
  }
  let home: string;
  try {
    home = resolve(resolveExplodexHome({
      osHome: options.env.HOME,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    }));
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.update.home-invalid",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const discovery = await discoverInstalledPlugins({
    explodexHome: home,
    trigger: "update-check",
    signal: options.signal,
  });
  if (!discovery.ok) {
    return renderFailure({
      operation: OPERATION,
      code: discovery.code,
      message: discovery.message,
      details: {
        ...discovery.details,
        ...(discovery.completedDiscovery === undefined
          ? {}
          : { completedDiscovery: discovery.completedDiscovery }),
      },
      exitCode: exitCodeForError(discovery.code),
    });
  }
  const configured = options.env.EXPLODEX_PLUGIN_UPDATE_RECOMMENDATIONS;
  let updates: PluginUpdateMetadata[] = [];
  if (configured !== undefined && configured.length > 0) {
    try {
      const recommendations = await loadPluginUpdateRecommendations(resolve(
        options.env.PWD ?? process.cwd(),
        configured,
      ));
      const listing = await listPluginUpdateRecommendations({
        explodexHome: home,
        recommendations,
        signal: options.signal,
      });
      if (!listing.ok) {
        return renderFailure({
          operation: OPERATION,
          code: listing.code,
          message: listing.message,
          details: {
            completedDiscovery: discovery,
            stateChanged: false,
            sourceDelivered: false,
            downloaded: false,
          },
          exitCode: exitCodeForError(listing.code),
        });
      }
      updates = listing.recommendations;
    } catch (error: unknown) {
      return renderFailure({
        operation: OPERATION,
        code: "plugin.update.invalid-recommendation",
        message: error instanceof Error
          ? error.message
          : "Unable to load update recommendations.",
        details: {
          completedDiscovery: discovery,
          stateChanged: false,
          sourceDelivered: false,
          downloaded: false,
        },
      });
    }
  }
  const payload = {
    trigger: discovery.trigger,
    localDiscovery: {
      recovery: discovery.recovery,
      stateChanged: discovery.stateChanged,
      newlyRecorded: discovery.newlyRecorded,
      pending: discovery.pending,
      invalid: discovery.invalid,
      rendererRequested: discovery.rendererRequested,
      sourceDelivered: discovery.sourceDelivered,
    },
    updates,
    remoteRegistry: configured === undefined || configured.length === 0
      ? "not-configured" as const
      : "configured-snapshot" as const,
    stateChanged: false,
    sourceDelivered: false,
    downloaded: false,
    review: {
      status: discovery.pending.length === 0
        ? "not-required"
        : "required",
      target: "none" as const,
    },
  };
  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: 0,
    humanStdout: [
      `Plugin update check: ${updates.length} updates, ${discovery.pending.length} pending review`,
      configured === undefined || configured.length === 0
        ? "Remote registry recommendations are not configured in this release."
        : "Update recommendation metadata was listed without downloading artifacts.",
      "",
    ].join("\n"),
    humanStderr: "",
  };
}
