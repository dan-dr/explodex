import { describe, expect, test } from "bun:test";
import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { CLI_PACKAGE_ROOT, buildPackage } from "./helpers.ts";

const BUILD_HOOKS = [
  "after-staging-ready",
  "after-prior-moved",
  "after-new-published",
  "after-backup-removed",
] as const;

describe("CLI dist publication", () => {
  test("every injected publication failure or interruption keeps one complete canonical dist", async () => {
    try {
      await runBuild({ generation: "old" });
      expect(await generation()).toBe("old");

      for (const hook of BUILD_HOOKS) {
        for (const mode of ["failure", "SIGINT", "SIGTERM"] as const) {
          const before = await distInventory();
          const result = await runBuild({
            generation: "new",
            hook,
            mode,
            allowFailure: true,
          });
          expect(result.exitCode).not.toBe(0);

          const currentGeneration = await generation();
          expect(["old", "new"]).toContain(currentGeneration);
          await assertCompleteDist();

          if (hook === "after-staging-ready" || hook === "after-prior-moved") {
            expect(currentGeneration).toBe("old");
            expect(await distInventory()).toEqual(before);
          } else {
            expect(currentGeneration).toBe("new");
            await runBuild({ generation: "old" });
          }
        }
      }

      await runBuild({ generation: "new" });
      expect(await generation()).toBe("new");
      await assertCompleteDist();
    } finally {
      await buildPackage(CLI_PACKAGE_ROOT);
    }
  }, 180_000);
});

async function runBuild(options: {
  generation: "old" | "new";
  hook?: typeof BUILD_HOOKS[number];
  mode?: "failure" | "SIGINT" | "SIGTERM";
  allowFailure?: boolean;
}): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bash", "./scripts/run-build.sh"], {
    cwd: CLI_PACKAGE_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      EXPLODEX_CLI_BUILD_TEST_GENERATION: options.generation,
      ...(options.hook === undefined
        ? {}
        : {
            EXPLODEX_CLI_BUILD_TEST_HOOK: options.hook,
            EXPLODEX_CLI_BUILD_TEST_MODE: options.mode ?? "failure",
          }),
    },
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  if (!options.allowFailure && exitCode !== 0) {
    throw new Error(`CLI build failed (${exitCode}): ${stderr}`);
  }
  return { exitCode, stderr };
}

async function generation(): Promise<string> {
  return (await readFile(
    join(CLI_PACKAGE_ROOT, "dist", "build-generation.txt"),
    "utf8",
  )).trim();
}

async function assertCompleteDist(): Promise<void> {
  await access(join(CLI_PACKAGE_ROOT, "dist", "bin", "explodex.js"));
  await access(join(
    CLI_PACKAGE_ROOT,
    "dist",
    "runtime",
    "bin",
    "explodex-runtime-helper",
  ));
  await access(join(CLI_PACKAGE_ROOT, "dist", "cli", "index.js"));
  await access(join(CLI_PACKAGE_ROOT, "dist", "cli", "index.d.ts"));
}

async function distInventory(): Promise<Array<{ path: string; bytes: string }>> {
  const root = join(CLI_PACKAGE_ROOT, "dist");
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  files.sort();
  return Promise.all(files.map(async (path) => ({
    path: relative(root, path),
    bytes: Buffer.from(await readFile(path)).toString("base64"),
  })));
}
