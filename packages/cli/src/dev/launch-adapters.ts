/**
 * Injectable process spawn adapter for isolated development launches.
 * Production uses a macOS LaunchServices-friendly spawn with a complete enough
 * host environment for ChatGPT's app:// renderer; tests supply controlled fixtures.
 */

export type SpawnedProcess = {
  pid: number;
  /** Resolves when the process exits. */
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
  /** Soft request to exit; does not use process groups. */
  kill(signal?: "SIGTERM" | "SIGINT"): void;
};

export type LaunchSpawnOptions = {
  executablePath: string;
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  stdoutPath?: string;
  stderrPath?: string;
  /**
   * When true (default for production ChatGPT launches), inherit the parent
   * process environment then overlay explicit knobs. Secret-like keys are
   * still stripped. Tests may set false for hermetic fixtures.
   */
  inheritHostEnvironment?: boolean;
};

export type LaunchSpawnAdapter = {
  spawn(options: LaunchSpawnOptions): Promise<SpawnedProcess>;
};

/** Keys that must never be copied from the parent into a development launch. */
const SECRET_ENV_KEY_PATTERN =
  /^(.*_)?(TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTHORIZATION|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY)(_.*)?$/i;

const FORBIDDEN_EXACT_ENV_KEYS = new Set([
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "EXPLODEX_TOKEN",
]);

function isSecretEnvKey(key: string): boolean {
  if (FORBIDDEN_EXACT_ENV_KEYS.has(key)) return true;
  return SECRET_ENV_KEY_PATTERN.test(key);
}

/**
 * Build the environment for an isolated ChatGPT launch.
 * ChatGPT's app:// renderer fails under a too-minimal process environment;
 * inherit the non-secret host environment and overlay explicit isolation knobs.
 */
export function buildLaunchEnvironment(options: {
  explicit: Record<string, string | undefined>;
  inheritHostEnvironment?: boolean;
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parent = options.parentEnv ?? process.env;
  const inherit = options.inheritHostEnvironment !== false;
  const env: NodeJS.ProcessEnv = {};

  if (inherit) {
    for (const [key, value] of Object.entries(parent)) {
      if (value === undefined) continue;
      if (isSecretEnvKey(key)) continue;
      env[key] = value;
    }
  } else {
    // Hermetic/minimal path for controlled fixtures.
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SHELL",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "XPC_FLAGS",
      "XPC_SERVICE_NAME",
      "SSH_AUTH_SOCK",
      "__CF_USER_TEXT_ENCODING",
    ] as const) {
      const value = parent[key];
      if (value !== undefined) env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(options.explicit)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    if (isSecretEnvKey(key)) {
      // Explicit secret-like isolation knobs are never accepted.
      continue;
    }
    env[key] = value;
  }

  // Ensure Electron is not forced into node mode.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export async function createNodeLaunchSpawnAdapter(): Promise<LaunchSpawnAdapter> {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");

  return {
    async spawn(options) {
      const stdout =
        options.stdoutPath !== undefined
          ? fs.openSync(options.stdoutPath, "a")
          : "ignore";
      const stderr =
        options.stderrPath !== undefined
          ? fs.openSync(options.stderrPath, "a")
          : "ignore";

      const env = buildLaunchEnvironment({
        explicit: options.env,
        inheritHostEnvironment: options.inheritHostEnvironment,
      });

      // Prefer the app bundle root as cwd when launching the inner executable so
      // relative resource resolution matches LaunchServices-style starts.
      let cwd = options.cwd;
      if (cwd === undefined) {
        const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
        const index = options.executablePath.lastIndexOf(marker);
        if (index > 0) {
          cwd = options.executablePath.slice(0, index);
        }
      }

      const child = spawn(options.executablePath, [...options.argv], {
        cwd,
        env,
        stdio: ["ignore", stdout, stderr],
        // The one-shot lifecycle command must exit while ChatGPT keeps running.
        // A separate process group is safe because lifecycle termination always
        // revalidates and signals only the exact recorded PID, never the group.
        detached: true,
      });

      if (typeof stdout === "number") fs.closeSync(stdout);
      if (typeof stderr === "number") fs.closeSync(stderr);

      const pid = child.pid;
      if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
        throw new Error("Failed to spawn development ChatGPT process");
      }

      let exitResult: { exitCode: number | null; signal: string | null } | null = null;
      const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
        (resolve) => {
          child.once("exit", (code, signal) => {
            exitResult = {
              exitCode: code,
              signal: signal === null ? null : String(signal),
            };
            resolve(exitResult);
          });
        },
      );
      child.unref();

      return {
        pid,
        wait() {
          return exitResult !== null ? Promise.resolve(exitResult) : exitPromise;
        },
        kill(signal = "SIGTERM") {
          try {
            child.kill(signal);
          } catch {
            // Process may already be gone.
          }
        },
      };
    },
  };
}
