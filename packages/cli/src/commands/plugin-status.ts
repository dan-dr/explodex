import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { successEnvelope, type RenderedCliResult } from "../output/envelope.ts";
import { loadPluginsState } from "../plugin/install-state.ts";
import {
  inspectPluginManagementOnDevelopmentTarget,
} from "../plugin/management-target.ts";

const OPERATION = "plugin.status";

export async function runPluginStatus(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const tokens = [...options.rest, ...options.endOfOptions];
  const option = tokens.find((token) => token.startsWith("-"));
  if (option !== undefined) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.unknown-option",
      message: `Unexpected option '${option}'.`,
      usageLine: "Usage: explodex plugin status [id]",
      helpPath: "plugin status",
      details: { option },
    });
  }
  if (tokens.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${tokens[1]}'.`,
      usageLine: "Usage: explodex plugin status [id]",
      helpPath: "plugin status",
    });
  }
  const id = tokens[0] ?? null;
  let home: string;
  try {
    home = resolve(resolveExplodexHome({
      osHome: options.env.HOME,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    }));
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.status.home-invalid",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }

  if (options.signal?.aborted) {
    return interruptedStatus();
  }
  const loaded = await loadPluginsState({ explodexHome: home });
  if (options.signal?.aborted) {
    return interruptedStatus();
  }
  if (loaded.status === "malformed") {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.state.invalid",
      message:
        "plugins.json is malformed or unsupported; no persisted activation authority is accepted.",
    });
  }
  const plugins = loaded.status === "valid"
    ? loaded.state.plugins
    : {};
  const selected = id === null
    ? plugins
    : plugins[id] === undefined
      ? {}
      : { [id]: plugins[id] };
  const devRoot = options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT;
  const observed = devRoot === undefined
    ? null
    : await inspectPluginManagementOnDevelopmentTarget({
        osHome: options.env.HOME ?? "",
        explodexHome: home,
        explicitRoot: devRoot,
        timeoutMs: options.globals.timeoutMs,
        openUi: false,
        signal: options.signal,
      });
  const observedById = new Map(
    observed?.plugins.map((plugin) => [plugin.id, plugin.application]) ?? [],
  );
  const payload = {
    stateStatus: loaded.status,
    schemaVersion: loaded.status === "valid" ? loaded.state.schemaVersion : 1,
    plugins: selected,
    applications: Object.fromEntries(
      Object.keys(selected).sort().map((pluginId) => [
        pluginId,
        observedById.get(pluginId) ?? {
          status: "unknown" as const,
          lifecycle: null,
          boundary: "none" as const,
          observedIdentity: null,
          observedAt: null,
          message:
            "No exact renderer application state was inspected by this read-only status operation.",
        },
      ]),
    ),
    discovered: false,
    stateChanged: false,
    inspectedTarget: observed?.ok === true ? observed.target : null,
    inspection: observed === null
      ? "not-requested" as const
      : observed.ok
        ? "completed" as const
        : "unavailable" as const,
  };
  const lines = [
    `Plugin state: ${loaded.status}`,
    ...Object.entries(selected).map(([pluginId, record]) =>
      `${pluginId}: ${record.enabled === null ? "disabled" : `enabled ${record.enabled.version} ${record.enabled.payloadSha256}`} (${record.pendingReview.length} pending), application ${observedById.get(pluginId)?.status ?? "unknown"}`
    ),
    "",
  ];
  return {
    envelope: successEnvelope(
      OPERATION,
      payload,
      observed !== null && !observed.ok
        ? [{
            code: observed.code,
            message: observed.message,
          }]
        : [],
    ),
    exitCode: 0,
    humanStdout: lines.join("\n"),
    humanStderr: observed !== null && !observed.ok
      ? `Application inspection unavailable: ${observed.message}\n`
      : "",
  };
}

function interruptedStatus(): RenderedCliResult {
  return renderFailure({
    operation: OPERATION,
    code: "operation.interrupted",
    message: "Plugin status was interrupted.",
  });
}
