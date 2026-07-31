#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const stagingRoot = join(packageRoot, "dist-build");
const finalRoot = join(packageRoot, "dist");
const backupRoot = join(packageRoot, `.dist-backup-${process.pid}`);
const buildLockRoot = join(packageRoot, ".dist-build.lock");
const BUILD_LOCK_TIMEOUT_MS = 180_000;
const tsc = join(repositoryRoot, "node_modules", ".bin", "tsc");

let interruptedBy: "SIGINT" | "SIGTERM" | null = null;
const onSigint = (): void => {
  interruptedBy ??= "SIGINT";
};
const onSigterm = (): void => {
  interruptedBy ??= "SIGTERM";
};
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

const releaseBuildLock = await acquireBuildLock();
try {
  await buildAndPublish();
} finally {
  await releaseBuildLock();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}

type BuildLockOwner = {
  pid: number;
  token: string;
  createdAt: number;
};

async function acquireBuildLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS;
  const owner: BuildLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };

  for (;;) {
    throwIfInterrupted();
    try {
      await mkdir(buildLockRoot);
      await writeFile(
        join(buildLockRoot, "owner.json"),
        `${JSON.stringify(owner)}\n`,
        "utf8",
      );
      return async () => {
        const current = await readBuildLockOwner();
        if (current?.token === owner.token) {
          await rm(buildLockRoot, { recursive: true, force: true });
        }
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await buildLockIsStale()) {
        await rm(buildLockRoot, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting ${BUILD_LOCK_TIMEOUT_MS}ms for CLI build lock ${buildLockRoot}`,
        );
      }
      await Bun.sleep(50);
    }
  }
}

async function readBuildLockOwner(): Promise<BuildLockOwner | null> {
  try {
    const value = JSON.parse(
      await readFile(join(buildLockRoot, "owner.json"), "utf8"),
    ) as Partial<BuildLockOwner>;
    return typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      typeof value.createdAt === "number" &&
      Number.isFinite(value.createdAt)
      ? value as BuildLockOwner
      : null;
  } catch {
    return null;
  }
}

async function buildLockIsStale(): Promise<boolean> {
  const owner = await readBuildLockOwner();
  if (owner !== null) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  try {
    const lockStat = await stat(buildLockRoot);
    return Date.now() - lockStat.mtimeMs >= 5_000;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function buildAndPublish(): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(backupRoot, { recursive: true, force: true });

  const compilation = Bun.spawn([tsc, "-p", join(packageRoot, "tsconfig.build.json")], {
    cwd: packageRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await compilation.exited;
  if (exitCode !== 0) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw new Error(`CLI TypeScript compilation failed with exit ${exitCode}.`);
  }
  throwIfInterrupted();

  const sourceHelper = join(packageRoot, "src", "runtime", "bin", "explodex-runtime-helper");
  const targetHelperDirectory = join(stagingRoot, "runtime", "bin");
  const targetHelper = join(targetHelperDirectory, "explodex-runtime-helper");
  await mkdir(targetHelperDirectory, { recursive: true });
  await copyFile(sourceHelper, targetHelper);
  await chmod(targetHelper, 0o755);

  // Ensure the public bin has a Node shebang and is executable.
  const binPath = join(stagingRoot, "bin", "explodex.js");
  const binSource = await readFile(binPath, "utf8");
  const withShebang = binSource.startsWith("#!")
    ? binSource
    : `#!/usr/bin/env node\n${binSource}`;
  await writeFile(binPath, withShebang, { mode: 0o755 });
  await chmod(binPath, 0o755);

  const testGeneration = process.env.EXPLODEX_CLI_BUILD_TEST_GENERATION;
  if (testGeneration !== undefined) {
    await writeFile(
      join(stagingRoot, "build-generation.txt"),
      `${testGeneration}\n`,
      "utf8",
    );
  }

  await publicationHook("after-staging-ready");
  throwIfInterrupted();

  const hadPriorDist = await pathExists(finalRoot);
  let priorMoved = false;
  let newPublished = false;
  try {
    if (hadPriorDist) {
      await rename(finalRoot, backupRoot);
      priorMoved = true;
    }
    await publicationHook("after-prior-moved");
    throwIfInterrupted();

    await rename(stagingRoot, finalRoot);
    newPublished = true;
    await publicationHook("after-new-published");
    throwIfInterrupted();

    if (priorMoved) {
      await rm(backupRoot, { recursive: true, force: true });
      priorMoved = false;
    }
    await publicationHook("after-backup-removed");
    throwIfInterrupted();
  } catch (error: unknown) {
    if (!newPublished && priorMoved && !(await pathExists(finalRoot))) {
      await rename(backupRoot, finalRoot);
      priorMoved = false;
    }
    if (newPublished && priorMoved) {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
      priorMoved = false;
    }
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function publicationHook(
  hook:
    | "after-staging-ready"
    | "after-prior-moved"
    | "after-new-published"
    | "after-backup-removed",
): Promise<void> {
  if (process.env.EXPLODEX_CLI_BUILD_TEST_HOOK !== hook) return;
  const mode = process.env.EXPLODEX_CLI_BUILD_TEST_MODE;
  if (mode === "SIGINT" || mode === "SIGTERM") {
    process.emit(mode);
    return;
  }
  throw new Error(`Injected CLI dist publication failure at ${hook}.`);
}

function throwIfInterrupted(): void {
  if (interruptedBy !== null) {
    throw new Error(`CLI dist publication interrupted by ${interruptedBy}.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}
