import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_PACKAGE_ROOT,
  SYSTEM_PATH,
  buildPackage,
  miseNodeBinary,
} from "../package/helpers.ts";

describe("spawned CLI timeout and interruption", () => {
  test("SIGINT, SIGTERM, and deadline flush exactly one classified envelope", async () => {
    await buildPackage(CLI_PACKAGE_ROOT);
    const fixture = await createStalledConfigWorkspace();
    try {
      for (const scenario of [
        { name: "timeout", args: ["--timeout", "10ms"], signal: null, exitCode: 5, code: "operation.timeout" },
        { name: "sigint", args: [], signal: "SIGINT", exitCode: 130, code: "operation.interrupted" },
        { name: "sigterm", args: [], signal: "SIGTERM", exitCode: 130, code: "operation.interrupted" },
      ] as const) {
        const result = await runScenario({
          workspace: fixture.workspace,
          home: join(fixture.root, `home-${scenario.name}`),
          args: scenario.args,
          signal: scenario.signal,
        });
        expect(result.exitCode).toBe(scenario.exitCode);
        const lines = result.stdout.trimEnd().split("\n");
        expect(lines).toHaveLength(1);
        const envelope = JSON.parse(lines[0]!) as {
          schemaVersion: number;
          ok: boolean;
          operation: string;
          error: { code: string };
        };
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.ok).toBe(false);
        expect(envelope.operation).toBe("plugin.validate");
        expect(envelope.error.code).toBe(scenario.code);
        expect(result.stderr).not.toContain("{\"schemaVersion\"");
        await Bun.sleep(25);
        expect(configExecutionProcesses(fixture.workspace)).toEqual([]);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function runScenario(options: {
  workspace: string;
  home: string;
  args: readonly string[];
  signal: "SIGINT" | "SIGTERM" | null;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const node = miseNodeBinary(22);
  const proc = Bun.spawn([
    node,
    join(CLI_PACKAGE_ROOT, "dist", "bin", "explodex.js"),
    "--json",
    ...options.args,
    "plugin",
    "validate",
  ], {
    cwd: options.workspace,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${join(node, "..")}:${SYSTEM_PATH}`,
      HOME: options.home,
      PWD: options.workspace,
    },
  });
  if (options.signal !== null) {
    await waitForConfigExecution(proc, options.workspace);
    proc.kill(options.signal);
  }
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

async function waitForConfigExecution(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  workspace: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`CLI exited with code ${proc.exitCode} before config execution was ready.`);
    }
    const processes = configExecutionProcesses(workspace);
    if (
      processes.some((line) => line.includes("config-loader-worker")) &&
      processes.some((line) => line.includes("explodex-config-descendant"))
    ) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timeout waiting for config loader and descendant after ${timeoutMs}ms.`);
}

async function createStalledConfigWorkspace(): Promise<{
  root: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "explodex-cli-process-stalled-"));
  const workspace = join(root, "explodex-plugin-stalled");
  await mkdir(join(workspace, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(workspace, "package.json"), `${JSON.stringify({
      name: "explodex-plugin-stalled",
      version: "0.0.0",
      private: true,
      peerDependencies: {
        "@explodex/sdk": "^1.2.0",
      },
    }, null, 2)}\n`),
    writeFile(
      join(workspace, "explodex.config.ts"),
      [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, [",
        "  '-e',",
        "  \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\",",
        "  'explodex-config-descendant',",
        "  process.argv[2] ?? '',",
        "], { stdio: 'inherit' });",
        "await new Promise(() => {});",
        "export default {};",
        "",
      ].join("\n"),
    ),
    writeFile(join(workspace, "src", "index.ts"), "export default {};\n"),
    writeFile(join(workspace, "README.md"), "# stalled\n"),
    writeFile(join(workspace, "tsconfig.json"), "{}\n"),
  ]);
  return { root, workspace };
}

function configExecutionProcesses(workspace: string): string[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.includes(workspace) &&
      (
        line.includes("config-loader-worker") ||
        line.includes("explodex-config-descendant")
      )
    );
}
