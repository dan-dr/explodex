/**
 * Injectable filesystem and process adapters for host inspection.
 * Production uses Node APIs; tests supply controlled fixtures.
 */

export type FileStatKind = "file" | "directory" | "symlink" | "other" | "missing";

export type FileStat = {
  kind: FileStatKind;
  mode?: number;
  size?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type HostFileSystem = {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  /** Optional write used only by home/state modules, never against the host bundle. */
  writeFile?(path: string, data: Uint8Array | string): Promise<void>;
  mkdir?(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  readText?(path: string): Promise<string>;
};

export type HostProcess = {
  execFile(
    file: string,
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<ExecResult>;
};

export type HostClock = {
  nowIso(): string;
};

export type HostHash = {
  sha256Hex(data: Uint8Array): string;
};

export type HostAdapters = {
  fs: HostFileSystem;
  process: HostProcess;
  clock: HostClock;
  hash: HostHash;
};

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Production filesystem adapter backed by node:fs/promises. */
export async function createNodeFileSystem(): Promise<HostFileSystem> {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");

  return {
    async exists(path) {
      try {
        await fs.access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async stat(path) {
      try {
        const st = await fs.lstat(path);
        if (st.isSymbolicLink()) return { kind: "symlink", mode: st.mode, size: st.size };
        if (st.isDirectory()) return { kind: "directory", mode: st.mode, size: st.size };
        if (st.isFile()) return { kind: "file", mode: st.mode, size: st.size };
        return { kind: "other", mode: st.mode, size: st.size };
      } catch {
        return { kind: "missing" };
      }
    },
    async realpath(path) {
      return fs.realpath(path);
    },
    async readFile(path) {
      const buf = await fs.readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async writeFile(path, data) {
      const bytes = typeof data === "string" ? encodeUtf8(data) : data;
      await fs.writeFile(path, bytes, { mode: 0o600 });
    },
    async mkdir(path, options) {
      await fs.mkdir(path, { recursive: options?.recursive ?? true, mode: options?.mode ?? 0o700 });
    },
    async rename(from, to) {
      await fs.rename(from, to);
    },
    async readText(path) {
      return fs.readFile(path, "utf8");
    },
  };
}

/** Production process adapter backed by node:child_process.execFile. */
export async function createNodeProcess(): Promise<HostProcess> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  return {
    async execFile(file, args, options) {
      try {
        const result = await execFileAsync(file, [...args], {
          encoding: "utf8",
          cwd: options?.cwd,
          maxBuffer: 8 * 1024 * 1024,
        });
        return {
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
          exitCode: 0,
        };
      } catch (error: unknown) {
        const err = error as {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          message?: string;
        };
        const exitCode =
          typeof err.code === "number"
            ? err.code
            : typeof err.code === "string" && err.code === "ENOENT"
              ? 127
              : 1;
        return {
          stdout: String(err.stdout ?? ""),
          stderr: String(err.stderr ?? err.message ?? ""),
          exitCode,
        };
      }
    },
  };
}

export function createSystemClock(): HostClock {
  return {
    nowIso() {
      return new Date().toISOString();
    },
  };
}

export async function createNodeHash(): Promise<HostHash> {
  const { createHash } = await import("node:crypto");
  return {
    sha256Hex(data) {
      return createHash("sha256").update(data).digest("hex");
    },
  };
}

export async function createDefaultHostAdapters(): Promise<HostAdapters> {
  const [fs, process, hash] = await Promise.all([
    createNodeFileSystem(),
    createNodeProcess(),
    createNodeHash(),
  ]);
  return {
    fs,
    process,
    clock: createSystemClock(),
    hash,
  };
}
