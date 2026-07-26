/**
 * Once-only bounded execution of trusted local explodex.config.ts.
 * Uses a Node child process only; never invokes package lifecycle scripts.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExplodexConfig } from "@explodex/sdk";

export type ConfigLoadSuccess = {
  ok: true;
  config: ExplodexConfig;
  /** Always 1: the parent invokes the child exactly once per validation. */
  executions: 1;
};

export type ConfigLoadFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ConfigLoadResult = ConfigLoadSuccess | ConfigLoadFailure;

const DEFAULT_CONFIG_RELATIVE = "explodex.config.ts";

async function resolveWorkerPathExisting(): Promise<string> {
  // Compiled layout: dist/plugin/config-load.js → sibling config-loader-worker.js
  // Source layout under bun test: src/plugin/config-load.ts → sibling .ts worker
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceUrl = import.meta.url;
  if (sourceUrl.endsWith(".ts") || sourceUrl.endsWith(".tsx")) {
    return join(here, "config-loader-worker.ts");
  }
  const compiled = join(here, "config-loader-worker.js");
  await access(compiled);
  return compiled;
}

/**
 * Execute trusted local config exactly once in a bounded child.
 * Never runs npm/bun package lifecycle scripts.
 */
export async function loadExplodexConfigOnce(options: {
  workspacePath: string;
  timeoutMs: number;
  configRelativePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigLoadResult> {
  const configRelative = options.configRelativePath ?? DEFAULT_CONFIG_RELATIVE;
  const workerPath = await resolveWorkerPathExisting();
  const nodeBin = process.execPath;

  // Sanitize env so package managers and install hooks are not invited.
  const parentEnv = options.env ?? process.env;
  const childEnv: NodeJS.ProcessEnv = {
    PATH: parentEnv.PATH,
    HOME: parentEnv.HOME,
    TMPDIR: parentEnv.TMPDIR,
    TEMP: parentEnv.TEMP,
    TMP: parentEnv.TMP,
    NODE_OPTIONS: parentEnv.NODE_OPTIONS,
    // Explicitly do not set npm_lifecycle_event / npm_config_* that would
    // suggest package script execution. Child is plain Node.
  };
  // Preserve NODE_PATH only when provided for fixture resolution.
  if (typeof parentEnv.NODE_PATH === "string" && parentEnv.NODE_PATH.length > 0) {
    childEnv.NODE_PATH = parentEnv.NODE_PATH;
  }

  return await new Promise<ConfigLoadResult>((resolvePromise) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(
      nodeBin,
      [workerPath, options.workspacePath, configRelative],
      {
        cwd: options.workspacePath,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        // Windows-irrelevant on darwin; keep detached false so parent reaps.
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate only after a short grace; still no package scripts involved.
      setTimeout(() => {
        if (!settled && !child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 1_000).unref?.();
    }, Math.max(1, options.timeoutMs));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const finish = (result: ConfigLoadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.on("error", (error: Error) => {
      finish({
        ok: false,
        code: "plugin.source.invalid",
        message: `Failed to start config loader: ${error.message}`,
        details: { stage: "spawn" },
      });
    });

    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          code: "operation.timeout",
          message: `explodex.config.ts exceeded the ${options.timeoutMs}ms bound.`,
          details: { timeoutMs: options.timeoutMs, signal },
        });
        return;
      }

      const line = firstJsonLine(stdout);
      if (line === null) {
        finish({
          ok: false,
          code: "plugin.source.invalid",
          message:
            exitCode === 0
              ? "Config loader produced no machine-readable result."
              : `Config loader exited with code ${exitCode ?? "null"}${signal ? ` signal ${signal}` : ""}.`,
          details: {
            exitCode,
            signal,
            stderr: stderr.slice(0, 2_000),
          },
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        finish({
          ok: false,
          code: "plugin.source.invalid",
          message: "Config loader returned malformed JSON.",
          details: { stdout: line.slice(0, 500) },
        });
        return;
      }

      if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
        finish({
          ok: false,
          code: "plugin.source.invalid",
          message: "Config loader returned an unexpected payload.",
        });
        return;
      }

      if (parsed.ok === true) {
        if (!isRecord(parsed.config)) {
          finish({
            ok: false,
            code: "plugin.source.invalid",
            message: "Config loader returned no configuration object.",
          });
          return;
        }
        finish({
          ok: true,
          config: parsed.config as ExplodexConfig,
          executions: 1,
        });
        return;
      }

      finish({
        ok: false,
        code: typeof parsed.code === "string" ? parsed.code : "plugin.source.invalid",
        message:
          typeof parsed.message === "string"
            ? parsed.message
            : "explodex.config.ts failed.",
        details: isRecord(parsed.details)
          ? (parsed.details as Record<string, unknown>)
          : { stderr: stderr.slice(0, 2_000) },
      });
    });
  });
}

function firstJsonLine(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
