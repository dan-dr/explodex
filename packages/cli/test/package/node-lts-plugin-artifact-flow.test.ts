import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLI_PACKAGE_ROOT,
  REPO_ROOT,
  SDK_PACKAGE_ROOT,
  SYSTEM_PATH,
  buildPackage,
  installSdkAndCli,
  miseNodeBinary,
  packActual,
} from "./helpers.ts";

async function runPacked(options: {
  nodeBin: string;
  bin: string;
  cwd: string;
  home: string;
  args: string[];
}): Promise<{ exitCode: number; stdout: string; stderr: string; json: Record<string, unknown> }> {
  const proc = Bun.spawn([options.nodeBin, options.bin, "--json", ...options.args], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${dirname(options.nodeBin)}:${SYSTEM_PATH}`,
      HOME: options.home,
      TMPDIR: dirname(options.home),
    },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const lines = stdout.trimEnd().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return { exitCode, stdout, stderr, json: JSON.parse(lines[0]!) as Record<string, unknown> };
}

function resultOf(value: Record<string, unknown>): Record<string, unknown> {
  const result = value.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("expected result object");
  }
  return result as Record<string, unknown>;
}

describe("VAL-SDK-044/045 packed external artifact flow", () => {
  test("Node 22 and 24 create, validate, build, artifact-validate, package, and install through public envelopes", async () => {
    await buildPackage(SDK_PACKAGE_ROOT);
    await buildPackage(CLI_PACKAGE_ROOT);
    const scratch = await mkdtemp(join(tmpdir(), "explodex-node-lts-artifact-flow-"));
    try {
      const sdk = await packActual(SDK_PACKAGE_ROOT, join(scratch, "pack-sdk"));
      const cli = await packActual(CLI_PACKAGE_ROOT, join(scratch, "pack-cli"));
      const installed = await installSdkAndCli({
        sdkTarball: sdk.tarballPath,
        cliTarball: cli.tarballPath,
      });
      try {
        const typescriptRoot = await realpath(join(REPO_ROOT, "node_modules", "typescript"));
        const bin = join(installed.consumerRoot, "node_modules", ".bin", "explodex");
        for (const major of [22, 24] as const) {
          const nodeBin = miseNodeBinary(major);
          const root = join(scratch, `external-${major}`);
          const home = join(root, "home");
          const workspace = join(root, `explodex-plugin-packed-flow-${major}`);
          await mkdir(root, { recursive: true });
          const base = { nodeBin, bin, cwd: root, home };

          const create = await runPacked({ ...base, args: ["plugin", "create", workspace] });
          expect(create.exitCode).toBe(0);
          expect(create.stderr).toBe("");
          expect(create.json.operation).toBe("plugin.create");
          const packagePath = join(workspace, "package.json");
          const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
          packageJson.devDependencies = {
            "@explodex/sdk": `file:${sdk.tarballPath}`,
            typescript: `file:${typescriptRoot}`,
          };
          await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
          const npmInstall = Bun.spawn(
            ["npm", "install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", "--offline"],
            {
              cwd: workspace,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env: {
                PATH: `${dirname(nodeBin)}:${SYSTEM_PATH}`,
                HOME: home,
                npm_config_cache: join(root, "npm-cache"),
                npm_config_ignore_scripts: "true",
                npm_config_offline: "true",
                npm_config_registry: "http://127.0.0.1:9/",
              },
            },
          );
          const npmExit = await npmInstall.exited;
          if (npmExit !== 0) {
            throw new Error(await new Response(npmInstall.stderr).text());
          }

          const validate = await runPacked({ ...base, cwd: workspace, args: ["plugin", "validate"] });
          expect(validate.exitCode).toBe(0);
          expect(validate.json.operation).toBe("plugin.validate");

          const build = await runPacked({ ...base, cwd: workspace, args: ["plugin", "build"] });
          expect(build.exitCode).toBe(0);
          expect(build.json.operation).toBe("plugin.build");

          const artifactValidate = await runPacked({
            ...base,
            cwd: workspace,
            args: ["plugin", "artifact", "validate", join(workspace, "dist")],
          });
          expect(artifactValidate.exitCode).toBe(0);
          expect(artifactValidate.json.operation).toBe("plugin.artifact.validate");

          const output = join(root, "artifacts");
          const packageResult = await runPacked({
            ...base,
            cwd: workspace,
            args: ["plugin", "package", "--output", output],
          });
          expect(packageResult.exitCode).toBe(0);
          expect(packageResult.json.operation).toBe("plugin.package");
          const packagePayload = resultOf(packageResult.json);
          const archivePath = packagePayload.outputPath;
          expect(typeof archivePath).toBe("string");
          if (typeof archivePath !== "string") throw new Error("expected archive outputPath");

          const archiveValidate = await runPacked({
            ...base,
            args: ["plugin", "artifact", "validate", archivePath],
          });
          expect(archiveValidate.exitCode).toBe(0);
          expect(archiveValidate.json.operation).toBe("plugin.artifact.validate");

          const install = await runPacked({
            ...base,
            args: ["plugin", "install", archivePath],
          });
          expect(install.exitCode).toBe(0);
          expect(install.stderr).toBe("");
          expect(install.json.operation).toBe("plugin.install");
          const installPayload = resultOf(install.json);
          expect(installPayload.payloadSha256).toBe(packagePayload.payloadSha256);
          expect(installPayload.archiveSha256).toBe(packagePayload.archiveSha256);
          expect(installPayload.enabled).toBe(false);
          expect(installPayload.pendingReview).toBe(true);
          expect(installPayload.outcome).toBe("installed");
          expect(installPayload.transportTrust).toBe(
            "computed-local-archive-not-publisher-authenticated",
          );
          const artifactPath = installPayload.artifactPath;
          expect(typeof artifactPath).toBe("string");
          if (typeof artifactPath !== "string") throw new Error("expected artifactPath");
          expect((await stat(artifactPath)).isDirectory()).toBe(true);
          expect(await readFile(join(artifactPath, "index.js"))).toEqual(
            await readFile(join(workspace, "dist", "index.js")),
          );

          const exact = await runPacked({ ...base, args: ["plugin", "add", archivePath] });
          expect(exact.exitCode).toBe(0);
          expect(resultOf(exact.json).outcome).toBe("already-installed");

          const invalid = await runPacked({
            ...base,
            args: ["plugin", "artifact", "validate", join(workspace, "README.md")],
          });
          expect(invalid.exitCode).toBe(1);
          expect(invalid.json.operation).toBe("plugin.artifact.validate");
          const error = invalid.json.error as Record<string, unknown>;
          expect(error.code).toBe("plugin.artifact.invalid");
        }
      } finally {
        await installed.cleanup();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 300_000);
});
