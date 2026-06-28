import { access, constants } from "node:fs/promises";
import { spawn } from "bun";

/**
 * Checks if a file or directory exists at the given path.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a command as a subprocess, inheriting stdin/stdout/stderr, and waits for it to exit.
 * Throws an error if the exit code is non-zero.
 */
export async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed with exit code ${code}`);
  }
}
