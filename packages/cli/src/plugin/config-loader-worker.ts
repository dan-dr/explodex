/**
 * Bounded child entry for once-only explodex.config.ts execution.
 * Invoked only by the CLI parent; not a public API.
 *
 * Protocol:
 * - argv[2] = absolute workspace root
 * - argv[3] = config relative path (default explodex.config.ts)
 * - stdout: one JSON line { ok: true, config } | { ok: false, code, message, details? }
 * - no package lifecycle scripts are involved
 */

import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { defineConfig, type ExplodexConfig } from "@explodex/sdk";

type LoaderSuccess = { ok: true; config: ExplodexConfig };
type LoaderFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

async function main(): Promise<void> {
  const workspaceArg = process.argv[2];
  const configRelative = process.argv[3] ?? "explodex.config.ts";
  if (typeof workspaceArg !== "string" || workspaceArg.length === 0) {
    writeFailure({
      ok: false,
      code: "plugin.source.invalid",
      message: "Config loader requires an absolute workspace path.",
    });
    process.exitCode = 1;
    return;
  }

  const workspacePath = resolve(workspaceArg);
  const configPath = join(workspacePath, configRelative);

  // Guard against path escape of the config file outside the workspace.
  if (!configPath.startsWith(workspacePath)) {
    writeFailure({
      ok: false,
      code: "plugin.source.invalid",
      message: "Config path escapes the workspace root.",
      details: { configPath, workspacePath },
    });
    process.exitCode = 1;
    return;
  }

  let moduleNamespace: Record<string, unknown>;
  try {
    moduleNamespace = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>;
  } catch (error: unknown) {
    writeFailure({
      ok: false,
      code: "plugin.source.invalid",
      message: formatImportError(error),
      details: { stage: "import", configPath },
    });
    process.exitCode = 1;
    return;
  }

  const exported =
    "default" in moduleNamespace ? moduleNamespace.default : moduleNamespace["config"];
  if (exported === undefined) {
    writeFailure({
      ok: false,
      code: "plugin.source.invalid",
      message: "explodex.config.ts must default-export a defineConfig(...) result.",
      details: { configPath },
    });
    process.exitCode = 1;
    return;
  }

  let config: ExplodexConfig;
  try {
    // Re-validate through defineConfig so raw objects and unknown fields fail closed.
    config = defineConfig(exported as ExplodexConfig);
  } catch (error: unknown) {
    writeFailure({
      ok: false,
      code: "plugin.source.invalid",
      message: error instanceof Error ? error.message : "defineConfig rejected the configuration.",
      details: { stage: "defineConfig" },
    });
    process.exitCode = 1;
    return;
  }

  const success: LoaderSuccess = { ok: true, config };
  process.stdout.write(`${JSON.stringify(success)}\n`);
  process.exitCode = 0;
}

function formatImportError(error: unknown): string {
  if (!(error instanceof Error)) return "Failed to import explodex.config.ts.";
  const message = error.message;
  if (message.includes("Unexpected") || message.includes("SyntaxError")) {
    return `explodex.config.ts has a syntax error: ${message}`;
  }
  return `Failed to load explodex.config.ts: ${message}`;
}

function writeFailure(failure: LoaderFailure): void {
  process.stdout.write(`${JSON.stringify(failure)}\n`);
}

main().catch((error: unknown) => {
  writeFailure({
    ok: false,
    code: "plugin.source.invalid",
    message: error instanceof Error ? error.message : "Config loader crashed.",
    details: { stage: "unhandled" },
  });
  process.exitCode = 1;
});
