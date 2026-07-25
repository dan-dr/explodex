/**
 * Injectable process spawn adapter for isolated development launches.
 * Production uses node:child_process.spawn; tests supply controlled fixtures.
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
};

export type LaunchSpawnAdapter = {
  spawn(options: LaunchSpawnOptions): Promise<SpawnedProcess>;
};

export async function createNodeLaunchSpawnAdapter(): Promise<LaunchSpawnAdapter> {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");

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

      // Never inherit secrets from the parent beyond an explicit sanitized env.
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(options.env)) {
        if (value !== undefined) env[key] = value;
      }
      // Minimal required OS environment for Electron/ChatGPT.
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
        const value = process.env[key];
        if (value !== undefined && env[key] === undefined) {
          env[key] = value;
        }
      }

      const child = spawn(options.executablePath, [...options.argv], {
        cwd: options.cwd,
        env,
        stdio: ["ignore", stdout, stderr],
        // Detached false keeps the process under the parent process group by default,
        // but we never signal by process group; only exact PID.
        detached: false,
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
