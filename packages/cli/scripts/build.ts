#!/usr/bin/env bun
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

try {
  await buildAndPublish();
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
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
