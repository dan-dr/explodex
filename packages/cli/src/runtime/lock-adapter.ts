import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type LockPathKind =
  | "missing"
  | "directory"
  | "regular-file"
  | "symlink"
  | "special";

export type LockPathStat = {
  kind: LockPathKind;
  mode: number;
  uid: number;
  device: string;
  inode: string;
  linkCount: number;
};

export type LeaseIdentity = {
  device: string;
  inode: string;
};

export type AdvisoryLease = {
  readonly path: string;
  readonly descriptor: number;
  readonly closeOnExec: true;
  stat(): Promise<LockPathStat>;
  close(): Promise<void>;
};

export type LeaseOpenResult =
  | { status: "acquired"; lease: AdvisoryLease }
  | { status: "busy" };

/** Outcome of publishing a fully prepared staging container under its final name. */
export type DirectoryPublishResult = "published" | "lost-race";

export type LockFileSystem = {
  statPath(path: string): Promise<LockPathStat>;
  readText(path: string): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  createDirectoryExclusive(path: string, mode?: number): Promise<boolean>;
  writeFileExclusive(path: string, data: string, mode?: number): Promise<boolean>;
  writeTextAtomic(path: string, data: string, mode?: number): Promise<void>;
  /**
   * Move a complete staging container to its final name with one rename.
   * A populated container at the destination means another process published first.
   */
  publishDirectoryExclusive(
    stagingPath: string,
    finalPath: string,
  ): Promise<DirectoryPublishResult>;
  removePrivateDirectory(path: string): Promise<void>;
  tryAcquireLease(path: string): Promise<LeaseOpenResult>;
  currentUid(): number;
};

const DARWIN_O_EXLOCK = 0x0000_0020;
const DARWIN_O_CLOEXEC = 0x0100_0000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function modeBits(mode: bigint): number {
  return Number(mode & 0o7777n);
}

function statKind(stats: BigIntStats): LockPathKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "regular-file";
  return "special";
}

function statRecord(stats: BigIntStats): LockPathStat {
  return {
    kind: statKind(stats),
    mode: modeBits(stats.mode),
    uid: Number(stats.uid),
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    linkCount: Number(stats.nlink),
  };
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Preserve the acquisition/validation error that triggered best-effort cleanup.
  }
}

export async function createNodeLockFileSystem(): Promise<LockFileSystem> {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");

  // No O_CREAT: container initialization owns the stable lease inode, so a
  // missing lease means substitution or corruption and must fail closed.
  const leaseFlags =
    constants.O_RDWR |
    constants.O_NONBLOCK |
    constants.O_NOFOLLOW |
    DARWIN_O_EXLOCK |
    DARWIN_O_CLOEXEC;

  const syncDirectory = async (directory: string): Promise<void> => {
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(directory, constants.O_RDONLY | DARWIN_O_CLOEXEC);
      await handle.sync();
    } catch {
      // Parent-directory durability is best effort where the platform allows it.
    } finally {
      if (handle !== null) await closeQuietly(handle);
    }
  };

  return {
    async statPath(path) {
      try {
        return statRecord(await fs.lstat(path, { bigint: true }));
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") {
          return {
            kind: "missing",
            mode: 0,
            uid: -1,
            device: "0",
            inode: "0",
            linkCount: 0,
          };
        }
        throw error;
      }
    },
    async readText(path) {
      return fs.readFile(path, "utf8");
    },
    async mkdir(path, options) {
      await fs.mkdir(path, {
        recursive: options?.recursive ?? true,
        mode: options?.mode ?? PRIVATE_DIRECTORY_MODE,
      });
    },
    async createDirectoryExclusive(path, mode = PRIVATE_DIRECTORY_MODE) {
      try {
        await fs.mkdir(path, { mode });
        return true;
      } catch (error: unknown) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
    },
    async writeFileExclusive(path, data, mode = PRIVATE_FILE_MODE) {
      try {
        await fs.writeFile(path, data, { encoding: "utf8", flag: "wx", mode });
        return true;
      } catch (error: unknown) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
    },
    async writeTextAtomic(path, data, mode = PRIVATE_FILE_MODE) {
      const { dirname, join } = await import("node:path");
      const { randomBytes } = await import("node:crypto");
      const directory = dirname(path);
      const temporaryPath = join(
        directory,
        `.owner-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
      );
      let handle: FileHandle | null = null;
      try {
        handle = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW | DARWIN_O_CLOEXEC, mode);
        await handle.writeFile(data, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporaryPath, path);
        await syncDirectory(directory);
      } catch (error: unknown) {
        if (handle !== null) await closeQuietly(handle);
        try {
          await fs.unlink(temporaryPath);
        } catch (cleanupError: unknown) {
          if (errorCode(cleanupError) !== "ENOENT") {
            // The original atomic-write failure remains the actionable result.
          }
        }
        throw error;
      }
    },
    async publishDirectoryExclusive(stagingPath, finalPath) {
      const { dirname } = await import("node:path");
      try {
        await fs.rename(stagingPath, finalPath);
      } catch (error: unknown) {
        const code = errorCode(error);
        if (code === "EEXIST" || code === "ENOTEMPTY") return "lost-race";
        throw error;
      }
      await syncDirectory(dirname(finalPath));
      return "published";
    },

    async removePrivateDirectory(path) {
      await fs.rm(path, { recursive: true, force: true });
    },
    async tryAcquireLease(path) {
      if (process.platform !== "darwin") {
        throw Object.assign(new Error("Darwin advisory leases are supported only on macOS"), {
          code: "ENOTSUP",
        });
      }
      let handle: FileHandle;
      try {
        handle = await fs.open(path, leaseFlags, PRIVATE_FILE_MODE);
      } catch (error: unknown) {
        const code = errorCode(error);
        if (code === "EAGAIN" || code === "EWOULDBLOCK") return { status: "busy" };
        throw error;
      }
      const leaseStat = statRecord(await handle.stat({ bigint: true }));
      if (leaseStat.kind !== "regular-file" || leaseStat.linkCount !== 1) {
        await closeQuietly(handle);
        throw Object.assign(
          new Error("Advisory lease descriptor must reference a single-link regular file"),
          { code: "EINVAL" },
        );
      }
      let closed = false;
      return {
        status: "acquired",
        lease: {
          path,
          descriptor: handle.fd,
          closeOnExec: true,
          async stat() {
            if (closed) throw new Error("Cannot stat a closed advisory lease descriptor");
            return statRecord(await handle.stat({ bigint: true }));
          },
          async close() {
            if (closed) return;
            await handle.close();
            closed = true;
          },
        },
      };
    },
    currentUid() {
      return typeof process.getuid === "function" ? process.getuid() : -1;
    },
  };
}
