import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { successEnvelope, type RenderedCliResult } from "../output/envelope.ts";
import { loadPluginsState } from "../plugin/install-state.ts";

const OPERATION = "plugin.status";

export async function runPluginStatus(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  rest: readonly string[];
  endOfOptions: readonly string[];
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

  const loaded = await loadPluginsState({ explodexHome: home });
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
  const payload = {
    stateStatus: loaded.status,
    schemaVersion: loaded.status === "valid" ? loaded.state.schemaVersion : 1,
    plugins: selected,
    discovered: false,
    stateChanged: false,
  };
  const lines = [
    `Plugin state: ${loaded.status}`,
    ...Object.entries(selected).map(([pluginId, record]) =>
      `${pluginId}: ${record.enabled === null ? "disabled" : `enabled ${record.enabled.version} ${record.enabled.payloadSha256}`} (${record.pendingReview.length} pending)`
    ),
    "",
  ];
  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: 0,
    humanStdout: lines.join("\n"),
    humanStderr: "",
  };
}
