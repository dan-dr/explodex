import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_PACKAGE_ROOT,
  SDK_PACKAGE_ROOT,
  SYSTEM_PATH,
  buildPackage,
  installSdkAndCli,
  miseNodeBinary,
  packRuntimeDependencyClosure,
  packActual,
} from "./helpers.ts";

describe("inert package installation", () => {
  test("scripts-disabled install creates no Explodex state or host side effects", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-inert-"));
    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "pack-sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "pack-cli"));
      const dependencyTarballs = await packRuntimeDependencyClosure(
        join(scratch, "pack-dependencies"),
      );
      const isolatedHome = join(scratch, "home");
      await mkdirp(isolatedHome);

      const before = await snapshotEffects(isolatedHome);
      const { consumerRoot, cleanup } = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
        dependencyTarballs,
        home: isolatedHome,
        offline: true,
      });
      try {
        const after = await snapshotEffects(isolatedHome);
        expect(after).toEqual(before);

        // No default .explodex under isolated home
        await expectMissing(join(isolatedHome, ".explodex"));

        // Packages installed under consumer node_modules only
        await access(join(consumerRoot, "node_modules", "explodex", "package.json"));
        await access(join(consumerRoot, "node_modules", "@explodex", "sdk", "package.json"));

        // Bin exists but was not executed during install
        const bin = join(consumerRoot, "node_modules", ".bin", "explodex");
        await access(bin);

        // Prove help works from install without creating home state.
        // Keep Bun out of PATH, but include a real Node directory for shebang resolution.
        const nodeDir = join(miseNodeBinary(22), "..");
        const result = Bun.spawnSync(
          [bin, "--help"],
          {
            cwd: consumerRoot,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PATH: `${nodeDir}:${SYSTEM_PATH}`,
              HOME: isolatedHome,
              npm_config_cache: join(scratch, "npm-cache"),
            },
          },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `help failed (${result.exitCode}): ${result.stderr.toString("utf8")}\n${result.stdout.toString("utf8")}`,
          );
        }
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString("utf8").toLowerCase().includes("bun")).toBe(false);
        const afterHelp = await snapshotEffects(isolatedHome);
        expect(afterHelp).toEqual(before);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});

async function mkdirp(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}

async function snapshotHome(home: string): Promise<string[]> {
  const names: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      const kind = entry.isDirectory()
        ? "d"
        : entry.isSymbolicLink()
          ? "l"
          : entry.isFile()
            ? "f"
            : "s";
      names.push(`${kind}:${relative}`);
      if (entry.isDirectory()) await walk(path, relative);
    }
  }
  await walk(home, "");
  return names.sort();
}

async function expectMissing(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`Expected missing path: ${path}`);
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code !== "ENOENT") throw error;
  }
}

async function snapshotEffects(home: string): Promise<Record<string, unknown>> {
  return {
    home: await snapshotHome(home),
    explodexState: await existingPaths([
      join(home, ".explodex"),
      join(home, ".explodex", "plugins"),
      join(home, ".explodex", "dev"),
      join(home, "Applications", "Explodex.app"),
      join(home, "Library", "LaunchAgents"),
    ]),
    host: await hostFingerprint(),
    hostProcesses: processLines(/\/Applications\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT/),
    declaredPorts: {
      main: portLines(9333),
      development: portLines(9444),
    },
  };
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const path of paths) {
    try {
      const info = await lstat(path);
      existing.push(`${path}:${info.mode}:${info.size}`);
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

async function hostFingerprint(): Promise<string | null> {
  const paths = [
    "/Applications/ChatGPT.app/Contents/Info.plist",
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  ];
  const hash = createHash("sha256");
  try {
    for (const path of paths) {
      const info = await stat(path);
      hash.update(`${path}\0${info.mode}\0${info.size}\0${info.mtimeMs}\0`);
      hash.update(await readFile(path));
    }
    return hash.digest("hex");
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function processLines(pattern: RegExp): string[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => pattern.test(line))
    .sort();
}

function portLines(port: number): string[] {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr.toString("utf8"));
  }
  return result.stdout
    .toString("utf8")
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort();
}
