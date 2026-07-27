import type { GlobalOptions } from "../cli/parse.ts";
import type { CliWarning } from "../output/envelope.ts";
import {
  inspectPluginManagementOnDevelopmentTarget,
} from "../plugin/management-target.ts";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function openPostOperationManagement(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  explodexHome: string;
  target: "main" | "development" | "none";
  signal?: AbortSignal;
}): Promise<{
  status: "opened" | "command-only" | "not-requested";
  command: string | null;
  plugins: unknown[];
  warning: CliWarning | null;
  humanLine: string;
}> {
  if (options.target !== "development") {
    return {
      status: "not-requested",
      command: null,
      plugins: [],
      warning: null,
      humanLine: "",
    };
  }
  const explicitRoot =
    options.globals.devRoot ?? options.env.EXPLODEX_DEV_ROOT ?? null;
  const command = [
    "explodex",
    "--home",
    quote(options.explodexHome),
    ...(explicitRoot === null
      ? []
      : ["--dev-root", quote(explicitRoot)]),
    "plugin",
    "status",
  ].join(" ");
  const result = await inspectPluginManagementOnDevelopmentTarget({
    osHome: options.env.HOME ?? "",
    explodexHome: options.explodexHome,
    explicitRoot,
    timeoutMs: options.globals.timeoutMs,
    openUi: true,
    signal: options.signal,
  });
  if (!result.ok) {
    return {
      status: "command-only",
      command,
      plugins: result.plugins,
      warning: {
        code: result.code,
        message:
          `${result.message} Run the exact public status command: ${command}`,
      },
      humanLine: `Management UI unavailable. Run: ${command}`,
    };
  }
  return {
    status: "opened",
    command,
    plugins: result.plugins,
    warning: null,
    humanLine: "Plugin management opened in the exact development renderer.",
  };
}
