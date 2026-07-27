import { describe, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetIdentity } from "../../src/cdp/types.ts";
import {
  evaluatePublishableGraduation,
} from "../../src/dev/graduation.ts";
import {
  runForegroundDevelop,
  type DevelopBuildResult,
  type DevelopPreflightSuccess,
  type DevelopRuntimeAdapters,
} from "../../src/dev/develop-operation.ts";
import {
  buildLocalSdkSource,
  validateLocalSdkSourceWorkspace,
} from "../../src/dev/local-sdk.ts";
import { extractNamedRootArchive } from "../../src/plugin/archive.ts";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import { readGenerationRecord } from "../../src/plugin/generation.ts";
import { packagePluginWorkspace } from "../../src/plugin/package.ts";
import {
  createValidWorkspace,
  SDK_PACKAGE_ROOT,
} from "../plugin/helpers.ts";
import type { GenerationRecord } from "../../src/plugin/generation.ts";

const TARGET: TargetIdentity = {
  role: "development",
  pid: 4242,
  processStartedAt: "2026-07-28T00:00:00.000001Z",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  appVersion: "26.721.41059",
  appBuild: "5848",
  port: 9444,
  browserIdentity: "Chrome/ChatGPT",
  targetId: "target-dev",
  targetType: "page",
  targetUrl: "app://-/index.html",
  executionContextId: 17,
  executionContextUniqueId: "context-dev",
  frameId: "frame-dev",
};

function pluginIdentity(generation: number) {
  return {
    id: "sample",
    version: `dev-${generation}`,
    payloadSha256: String(generation).repeat(64),
  };
}

function sdkIdentity(generation: number) {
  return {
    version: `1.2.${generation}`,
    sha256: String.fromCharCode(96 + generation).repeat(64),
  };
}

function generationRecord(
  kind: "publishable" | "local-source",
): GenerationRecord {
  return {
    schemaVersion: 1,
    generationId: "f".repeat(64),
    pluginId: "sample",
    version: "dev-1",
    mapMode: "required",
    sdkInput: {
      kind,
      version: "1.2.1",
      runtimeSha256: "a".repeat(64),
      ...(kind === "local-source"
        ? { declarationsSha256: "b".repeat(64) }
        : {}),
    },
    inputDigests: {},
    outputDigests: {},
    payloadSha256: "1".repeat(64),
  };
}

const PREFLIGHT: DevelopPreflightSuccess = {
  workspacePath: "/tmp/explodex-plugin-sample",
  watchedPaths: [
    "/tmp/explodex-plugin-sample",
    "/tmp/explodex-sdk-source",
  ],
  excludedPaths: [
    "/tmp/explodex-plugin-sample/dist",
    "/tmp/explodex-plugin-sample/node_modules",
    "/tmp/explodex-sdk-source/dist",
    "/tmp/explodex-sdk-source/node_modules",
  ],
  lifecycle: "dynamic",
  route: "dynamic",
  target: TARGET,
  pluginIdentity: null,
  sdkRuntimeIdentity: sdkIdentity(0),
  distPath: "/tmp/explodex-plugin-sample/dist",
  usesLocalSdk: true,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture.");
    await Bun.sleep(1);
  }
}

function invoke(callback: (() => void) | null, name: string): void {
  if (callback === null) throw new Error(`${name} callback is unavailable.`);
  callback();
}

describe("M4-F06 explicit local SDK development", () => {
  test("accepts only a canonical SDK source workspace and rejects aliases or non-source roots", async () => {
    const accepted = await validateLocalSdkSourceWorkspace({
      sdkSourcePath: SDK_PACKAGE_ROOT,
      pluginWorkspacePath: join(tmpdir(), "explodex-plugin-unrelated"),
      explodexHome: join(tmpdir(), "explodex-home-unrelated"),
      devRootPath: join(tmpdir(), "explodex-dev-unrelated"),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.message);
    expect(accepted.identity.packageName).toBe("@explodex/sdk");
    expect(accepted.identity.runtimePath.endsWith(
      "dist/runtime/explodex-runtime.iife.js",
    )).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "explodex-sdk-source-matrix-"));
    const pluginFixture = await createValidWorkspace({
      name: "explodex-plugin-not-an-sdk",
    });
    try {
      const alias = join(root, "sdk-alias");
      await symlink(SDK_PACKAGE_ROOT, alias);
      expect(await validateLocalSdkSourceWorkspace({
        sdkSourcePath: alias,
        pluginWorkspacePath: join(root, "plugin"),
        explodexHome: join(root, "home"),
        devRootPath: join(root, "dev"),
      })).toMatchObject({
        ok: false,
        code: "develop.sdk-source-invalid",
      });
      expect(await validateLocalSdkSourceWorkspace({
        sdkSourcePath: join(SDK_PACKAGE_ROOT, "dist"),
        pluginWorkspacePath: join(root, "plugin"),
        explodexHome: join(root, "home"),
        devRootPath: join(root, "dev"),
      })).toMatchObject({
        ok: false,
        code: "develop.sdk-source-invalid",
      });
      const tarball = join(root, "sdk.tgz");
      await writeFile(tarball, "not-an-sdk-workspace", "utf8");
      expect(await validateLocalSdkSourceWorkspace({
        sdkSourcePath: tarball,
        pluginWorkspacePath: join(root, "plugin"),
        explodexHome: join(root, "home"),
        devRootPath: join(root, "dev"),
      })).toMatchObject({
        ok: false,
        code: "develop.sdk-source-invalid",
      });
      expect(await validateLocalSdkSourceWorkspace({
        sdkSourcePath: pluginFixture.workspace,
        pluginWorkspacePath: join(root, "plugin"),
        explodexHome: join(root, "home"),
        devRootPath: join(root, "dev"),
      })).toMatchObject({
        ok: false,
        code: "develop.sdk-source-invalid",
      });
      expect(await validateLocalSdkSourceWorkspace({
        sdkSourcePath: SDK_PACKAGE_ROOT,
        pluginWorkspacePath: SDK_PACKAGE_ROOT,
        explodexHome: join(root, "home"),
        devRootPath: join(root, "dev"),
      })).toMatchObject({
        ok: false,
        code: "develop.sdk-source-invalid",
      });

      const driftedSdk = join(root, "drifted-sdk");
      await mkdir(driftedSdk);
      for (const name of [
        "package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "src",
        "scripts",
        "dist",
      ]) {
        await cp(join(SDK_PACKAGE_ROOT, name), join(driftedSdk, name), {
          recursive: true,
        });
      }
      await writeFile(
        join(driftedSdk, "dist", "index.d.ts"),
        "export declare const drifted: true;\n",
        "utf8",
      );
      expect(await validateLocalSdkSourceWorkspace({
        sdkSourcePath: driftedSdk,
        pluginWorkspacePath: join(root, "plugin"),
        explodexHome: join(root, "home"),
        devRootPath: join(root, "dev"),
      })).toMatchObject({
        ok: false,
        code: "develop.sdk-source-invalid",
      });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        pluginFixture.cleanup(),
      ]);
    }
  });

  test("finishes SDK N before plugin N and invalidates stale N when SDK N+1 starts", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const stale = deferred<DevelopBuildResult>();
    let onChange: (() => void) | null = null;
    let onStop: (() => void) | null = null;
    const adapters: DevelopRuntimeAdapters = {
      nowIso: () => "2026-07-28T00:00:01.000Z",
      debounceMs: 5,
      preflight: async () => ({ ok: true, value: PREFLIGHT }),
      openWatcher: async (options) => {
        onChange = options.onChange;
        onStop = options.onStop;
        return { close() {} };
      },
      openTargetMonitor: async () => ({ close() {} }),
      async buildGeneration({ generation, signal }) {
        calls.push(`sdk:${generation}:start`);
        if (generation === 1) {
          const built = await stale.promise;
          calls.push(`sdk:${generation}:done:${signal?.aborted === true}`);
          return built;
        }
        calls.push(`sdk:${generation}:done:false`);
        calls.push(`plugin:${generation}:start`);
        return {
          ok: true,
          pluginIdentity: pluginIdentity(generation),
          sdkRuntimeIdentity: sdkIdentity(generation),
        };
      },
      async applyGeneration({ generation, pluginIdentity }) {
        calls.push(`apply:${generation}`);
        return { ok: true, pluginIdentity, target: TARGET };
      },
      waitForStop: async () =>
        await new Promise<"completed">((resolve) => {
          onStop = () => resolve("completed");
        }),
      recoverSdkContamination: async () => ({
        ok: false,
        code: "develop.sdk-recovery-unexpected",
        message: "Recovery was not expected.",
      }),
      cleanup: async () => ({ ok: true, residuals: [] }),
      writeLine: (line) => lines.push(line),
    };
    const running = runForegroundDevelop({
      operationId: "sdk-ordering",
      adapters,
    });
    await waitFor(() => calls.includes("sdk:1:start"));
    invoke(onChange, "change");
    await waitFor(() => calls.includes("sdk:2:start"));
    stale.resolve({
      ok: true,
      pluginIdentity: pluginIdentity(1),
      sdkRuntimeIdentity: sdkIdentity(1),
    });
    await waitFor(() => calls.includes("apply:2"));
    invoke(onStop, "stop");
    const result = await running;
    expect(calls).not.toContain("plugin:1:start");
    expect(calls).not.toContain("apply:1");
    expect(calls.indexOf("sdk:2:done:false")).toBeLessThan(
      calls.indexOf("plugin:2:start"),
    );
    expect(result.lastGood).toMatchObject({
      generation: 2,
      pluginIdentity: pluginIdentity(2),
      sdkRuntimeIdentity: sdkIdentity(2),
    });
    expect(lines.join("\n")).not.toContain("/tmp/explodex-sdk-source");
  });

  test("an SDK build failure preserves the prior complete generated output", async () => {
    const root = await mkdtemp(join(tmpdir(), "explodex-sdk-build-failure-"));
    const sdkCopy = join(root, "sdk");
    await mkdir(sdkCopy);
    try {
      for (const name of [
        "package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "src",
        "scripts",
        "dist",
      ]) {
        await cp(join(SDK_PACKAGE_ROOT, name), join(sdkCopy, name), {
          recursive: true,
        });
      }
      const validated = await validateLocalSdkSourceWorkspace({
        sdkSourcePath: sdkCopy,
        pluginWorkspacePath: join(root, "plugin"),
        explodexHome: join(root, "home"),
        devRootPath: join(root, "dev"),
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw new Error(validated.message);
      const versionSourcePath = join(sdkCopy, "src", "version.ts");
      const priorSource = await readFile(versionSourcePath, "utf8");
      await writeFile(
        versionSourcePath,
        `${priorSource}\nconst sdkBuildTypeFailure: string = 42;\n`,
        "utf8",
      );
      const failed = await buildLocalSdkSource({
        source: validated.value,
        timeoutMs: 60_000,
      });
      expect(failed).toMatchObject({
        ok: false,
        code: "develop.sdk-build-failed",
      });
      if (failed.ok) throw new Error("expected local SDK build failure");
      expect(failed.priorDistFingerprint).not.toBeNull();
      expect(failed.distFingerprintAfter).toBe(
        failed.priorDistFingerprint,
      );

      await writeFile(versionSourcePath, priorSource, "utf8");
      const corrected = await buildLocalSdkSource({
        source: validated.value,
        timeoutMs: 60_000,
      });
      expect(corrected.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("pre-evaluation SDK failure preserves last-good without restart and later recovers", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    let onChange: (() => void) | null = null;
    let onStop: (() => void) | null = null;
    let generation = 0;
    const adapters: DevelopRuntimeAdapters = {
      nowIso: () => "2026-07-28T00:00:01.000Z",
      debounceMs: 5,
      preflight: async () => ({
        ok: true,
        value: {
          ...PREFLIGHT,
          pluginIdentity: pluginIdentity(0),
        },
      }),
      openWatcher: async (options) => {
        onChange = options.onChange;
        onStop = options.onStop;
        return { close() {} };
      },
      openTargetMonitor: async () => ({ close() {} }),
      async buildGeneration() {
        generation += 1;
        if (generation === 1) {
          return {
            ok: false,
            code: "develop.sdk-build-failed",
            message: "Local SDK build failed.",
            failureKind: "sdk",
            priorDistFingerprint: "sdk-good",
            distFingerprintAfter: "sdk-good",
          };
        }
        return {
          ok: true,
          pluginIdentity: pluginIdentity(2),
          sdkRuntimeIdentity: sdkIdentity(2),
        };
      },
      async applyGeneration({ pluginIdentity }) {
        calls.push("apply");
        return { ok: true, pluginIdentity, target: TARGET };
      },
      waitForStop: async () =>
        await new Promise<"completed">((resolve) => {
          onStop = () => resolve("completed");
        }),
      recoverSdkContamination: async () => {
        calls.push("restart");
        return { ok: true, target: TARGET };
      },
      cleanup: async () => ({ ok: true, residuals: [] }),
      writeLine: (line) => lines.push(line),
    };
    const running = runForegroundDevelop({
      operationId: "sdk-build-recovery",
      adapters,
    });
    await waitFor(() => calls.includes("apply"));
    invoke(onChange, "change");
    await waitFor(() => lines.some((line) =>
      JSON.parse(line).type === "build-failed"
    ));
    expect(calls).not.toContain("restart");
    invoke(onChange, "change");
    await waitFor(() => calls.filter((call) => call === "apply").length === 2);
    invoke(onStop, "stop");
    const result = await running;
    expect(result.lastGood?.generation).toBe(3);
  });

  test("permits one classified contamination restart and blocks when recovery fails", async () => {
    const lines: string[] = [];
    let recoveryCalls = 0;
    const adapters: DevelopRuntimeAdapters = {
      nowIso: () => "2026-07-28T00:00:01.000Z",
      preflight: async () => ({
        ok: true,
        value: {
          ...PREFLIGHT,
          pluginIdentity: pluginIdentity(1),
        },
      }),
      openWatcher: async () => ({ close() {} }),
      openTargetMonitor: async () => ({ close() {} }),
      buildGeneration: async () => ({
        ok: true,
        pluginIdentity: pluginIdentity(1),
        sdkRuntimeIdentity: sdkIdentity(1),
      }),
      applyGeneration: async () => ({
        ok: false,
        code: "develop.sdk-contaminated",
        message: "SDK bootstrap contaminated the renderer.",
        blocked: false,
        sdkContamination: true,
        stage: "evaluation",
        possiblePartialEffects: true,
      }),
      waitForStop: async () =>
        await new Promise<"completed">(() => {
          // The classified recovery failure ends this command.
        }),
      recoverSdkContamination: async () => {
        recoveryCalls += 1;
        return {
          ok: false,
          code: "dev.restart-timeout",
          message: "Exact development restart timed out.",
          details: { replacementLaunched: false },
        };
      },
      cleanup: async () => ({ ok: true, residuals: [] }),
      writeLine: (line) => lines.push(line),
    };
    const result = await runForegroundDevelop({
      operationId: "sdk-contamination-blocker",
      adapters,
    });
    expect(recoveryCalls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      reason: "blocked",
      error: { code: "dev.restart-timeout" },
      lastGood: null,
    });
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed.at(-2)).toMatchObject({
      type: "blocked",
      details: {
        code: "dev.restart-timeout",
        recoveryAttempted: true,
      },
    });
    expect(parsed.at(-1)).toMatchObject({
      type: "terminal",
      reason: "blocked",
      lastSequence: parsed.at(-2).sequence,
    });
  });

  test("restarts once after contamination and applies only a corrected newest pair", async () => {
    const replacementTarget: TargetIdentity = {
      ...TARGET,
      pid: 5252,
      processStartedAt: "2026-07-28T00:01:00.000001Z",
      targetId: "target-dev-restarted",
      executionContextId: 23,
      executionContextUniqueId: "context-dev-restarted",
      frameId: "frame-dev-restarted",
    };
    const calls: string[] = [];
    let onChange: (() => void) | null = null;
    let onStop: (() => void) | null = null;
    const adapters: DevelopRuntimeAdapters = {
      nowIso: () => "2026-07-28T00:01:01.000Z",
      debounceMs: 5,
      preflight: async () => ({
        ok: true,
        value: {
          ...PREFLIGHT,
          pluginIdentity: pluginIdentity(1),
        },
      }),
      openWatcher: async (options) => {
        onChange = options.onChange;
        onStop = options.onStop;
        return { close() {} };
      },
      openTargetMonitor: async () => ({ close() {} }),
      buildGeneration: async ({ generation }) => {
        calls.push(`build:${generation}`);
        return {
          ok: true,
          pluginIdentity: pluginIdentity(generation),
          sdkRuntimeIdentity: sdkIdentity(generation),
        };
      },
      applyGeneration: async ({
        generation,
        pluginIdentity,
        preflight,
      }) => {
        calls.push(`apply:${generation}:${preflight.target.targetId}`);
        if (generation === 1) {
          return {
            ok: false,
            code: "develop.sdk-contaminated",
            message: "SDK bootstrap contaminated the renderer.",
            blocked: false,
            sdkContamination: true,
            stage: "evaluation",
            possiblePartialEffects: true,
          };
        }
        return {
          ok: true,
          pluginIdentity,
          target: replacementTarget,
        };
      },
      waitForStop: async () =>
        await new Promise<"completed">((resolve) => {
          onStop = () => resolve("completed");
        }),
      recoverSdkContamination: async () => {
        calls.push("restart");
        return { ok: true, target: replacementTarget };
      },
      cleanup: async () => ({ ok: true, residuals: [] }),
      writeLine() {},
    };
    const running = runForegroundDevelop({
      operationId: "sdk-contamination-corrected",
      adapters,
    });
    await waitFor(() => calls.includes("restart"));
    invoke(onChange, "change");
    await waitFor(() =>
      calls.includes("apply:2:target-dev-restarted")
    );
    invoke(onStop, "stop");
    const result = await running;
    expect(calls.filter((call) => call === "restart")).toHaveLength(1);
    expect(result.lastGood).toMatchObject({
      generation: 2,
      pluginIdentity: pluginIdentity(2),
      sdkRuntimeIdentity: sdkIdentity(2),
      target: replacementTarget,
    });
  });

  test("a generation arriving during SDK recovery emits one final supersession blocker", async () => {
    const recovery = deferred<
      | { ok: true; target: TargetIdentity }
      | { ok: false; code: string; message: string }
    >();
    const lines: string[] = [];
    let onChange: (() => void) | null = null;
    const adapters: DevelopRuntimeAdapters = {
      nowIso: () => "2026-07-28T00:01:01.000Z",
      debounceMs: 5,
      preflight: async () => ({
        ok: true,
        value: {
          ...PREFLIGHT,
          pluginIdentity: pluginIdentity(1),
        },
      }),
      openWatcher: async (options) => {
        onChange = options.onChange;
        return { close() {} };
      },
      openTargetMonitor: async () => ({ close() {} }),
      buildGeneration: async () => ({
        ok: true,
        pluginIdentity: pluginIdentity(1),
        sdkRuntimeIdentity: sdkIdentity(1),
      }),
      applyGeneration: async () => ({
        ok: false,
        code: "develop.sdk-contaminated",
        message: "SDK bootstrap contaminated the renderer.",
        blocked: false,
        sdkContamination: true,
        stage: "evaluation",
        possiblePartialEffects: true,
      }),
      waitForStop: async () =>
        await new Promise<"completed">(() => {
          // The supersession blocker ends this command.
        }),
      recoverSdkContamination: async () => await recovery.promise,
      cleanup: async () => ({ ok: true, residuals: [] }),
      writeLine: (line) => lines.push(line),
    };
    const running = runForegroundDevelop({
      operationId: "sdk-recovery-superseded",
      adapters,
    });
    await waitFor(() => lines.some((line) =>
      JSON.parse(line).type === "apply-failed"
    ));
    invoke(onChange, "change");
    recovery.resolve({ ok: true, target: TARGET });
    const result = await running;
    expect(result).toMatchObject({
      ok: false,
      reason: "blocked",
      error: { code: "develop.sdk-recovery-superseded" },
    });
    const records = lines.map((line) => JSON.parse(line));
    expect(records.at(-2)).toMatchObject({
      type: "blocked",
      details: {
        code: "develop.sdk-recovery-superseded",
        recoveryAttempted: true,
      },
    });
    expect(records.at(-1)).toMatchObject({
      type: "terminal",
      reason: "blocked",
      lastSequence: records.at(-2).sequence,
    });
  });

  test("local-SDK build cannot package until a clean publishable rebuild", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-local-sdk-package-guard",
    });
    const sdkCopy = await mkdtemp(
      join(tmpdir(), "explodex-local-sdk-path-canary-"),
    );
    try {
      await writeFile(
        join(fixture.workspace, "bun.lock"),
        "local-lock-metadata-must-remain-unchanged\n",
        "utf8",
      );
      const packageJsonBefore = await readFile(
        join(fixture.workspace, "package.json"),
        "utf8",
      );
      const lockBefore = await readFile(
        join(fixture.workspace, "bun.lock"),
        "utf8",
      );
      for (const name of [
        "package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "src",
        "scripts",
        "dist",
      ]) {
        await cp(join(SDK_PACKAGE_ROOT, name), join(sdkCopy, name), {
          recursive: true,
        });
      }
      const localOnlyApiPath = join(
        sdkCopy,
        "dist",
        "types",
        "plugin.d.ts",
      );
      const localOnlyApiSource = await readFile(localOnlyApiPath, "utf8");
      await writeFile(
        localOnlyApiPath,
        localOnlyApiSource.replace(
          "readonly pluginId: string;",
          "readonly pluginId: string;\n    readonly localOnlyApi: () => string;",
        ),
        "utf8",
      );
      const localExpectedOutputPath = join(
        sdkCopy,
        "dist",
        "expected-output.json",
      );
      const localExpectedOutput = JSON.parse(
        await readFile(localExpectedOutputPath, "utf8"),
      ) as {
        files: Record<string, { sha256: string; bytes: number }>;
      };
      const localOnlyApiBytes = await readFile(localOnlyApiPath);
      const { createHash } = await import("node:crypto");
      localExpectedOutput.files["types/plugin.d.ts"] = {
        sha256: createHash("sha256").update(localOnlyApiBytes).digest("hex"),
        bytes: localOnlyApiBytes.byteLength,
      };
      await writeFile(
        localExpectedOutputPath,
        `${JSON.stringify(localExpectedOutput, null, 2)}\n`,
        "utf8",
      );
      const pluginEntryPath = join(fixture.workspace, "src", "index.ts");
      const publishablePluginSource = await readFile(pluginEntryPath, "utf8");
      await writeFile(
        pluginEntryPath,
        `import { definePlugin } from "@explodex/sdk";

export default definePlugin({
  setup(api) {
    globalThis.document?.documentElement.setAttribute(
      "data-local-sdk-api",
      api.localOnlyApi(),
    );
  },
});
`,
        "utf8",
      );
      const localBuild = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
        sdkSourcePath: sdkCopy,
      });
      expect(localBuild.ok).toBe(true);
      const localGeneration = await readGenerationRecord(
        join(fixture.workspace, "dist"),
      );
      expect(localGeneration?.sdkInput?.kind).toBe("local-source");
      expect(JSON.stringify(localGeneration)).not.toContain(sdkCopy);
      const packageBlocked = await packagePluginWorkspace({
        workspacePath: fixture.workspace,
        outputDir: join(fixture.root, "archives"),
        timeoutMs: 60_000,
      });
      expect(packageBlocked).toMatchObject({
        ok: false,
        code: "develop.local-sdk-not-publishable",
      });
      const distFiles = [
        "index.js",
        "index.js.map",
        "plugin.json",
        "checksums.json",
        ".explodex-generation.json",
      ];
      for (const relative of distFiles) {
        const contents = await readFile(
          join(fixture.workspace, "dist", relative),
          "utf8",
        );
        expect(contents).not.toContain(sdkCopy);
        expect(contents).not.toContain("file:");
        expect(contents).not.toContain("workspace:");
      }
      expect(await readFile(
        join(fixture.workspace, "package.json"),
        "utf8",
      )).toBe(packageJsonBefore);
      expect(await readFile(
        join(fixture.workspace, "bun.lock"),
        "utf8",
      )).toBe(lockBefore);

      await writeFile(pluginEntryPath, publishablePluginSource, "utf8");
      const cleanBuild = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
      });
      expect(cleanBuild.ok).toBe(true);
      if (!cleanBuild.ok) throw new Error(cleanBuild.message);
      const cleanGeneration = await readGenerationRecord(
        join(fixture.workspace, "dist"),
      );
      expect(cleanGeneration?.sdkInput?.kind).toBe("publishable");
      const packageAllowed = await packagePluginWorkspace({
        workspacePath: fixture.workspace,
        outputDir: join(fixture.root, "archives"),
        timeoutMs: 60_000,
      });
      expect(packageAllowed.ok).toBe(true);
      if (!packageAllowed.ok) throw new Error(packageAllowed.message);
      const archiveBytes = await readFile(packageAllowed.outputPath);
      const extracted = extractNamedRootArchive(archiveBytes);
      expect(extracted.ok).toBe(true);
      if (!extracted.ok) throw new Error(extracted.message);
      for (const bytes of extracted.extracted.files.values()) {
        expect(bytes.includes(Buffer.from(sdkCopy))).toBe(false);
        expect(bytes.includes(Buffer.from("file:"))).toBe(false);
        expect(bytes.includes(Buffer.from("workspace:"))).toBe(false);
      }

      expect(evaluatePublishableGraduation({
        generation: localGeneration,
        artifact: localBuild.ok
          ? {
              id: localBuild.report.id,
              version: localBuild.report.version,
              payloadSha256: localBuild.payloadSha256,
              lifecycle: localBuild.report.lifecycle,
              sdkRange: localBuild.report.sdkRange,
            }
          : null,
        devValidation: null,
        mainSdkRuntime: sdkIdentity(1),
      })).toMatchObject({
        ok: false,
        code: "develop.local-sdk-not-publishable",
      });
      expect(evaluatePublishableGraduation({
        generation: cleanGeneration,
        artifact: cleanBuild.ok
          ? {
              id: cleanBuild.report.id,
              version: cleanBuild.report.version,
              payloadSha256: cleanBuild.payloadSha256,
              lifecycle: cleanBuild.report.lifecycle,
              sdkRange: cleanBuild.report.sdkRange,
            }
          : null,
        devValidation: cleanBuild.ok
          ? {
              pluginIdentity: {
                id: cleanBuild.report.id,
                version: cleanBuild.report.version,
                payloadSha256: cleanBuild.payloadSha256,
              },
              sdkRuntimeIdentity: sdkIdentity(1),
              target: TARGET,
            }
          : null,
        mainSdkRuntime: sdkIdentity(1),
      })).toEqual({ ok: true });
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(sdkCopy, { recursive: true, force: true }),
      ]);
    }
  }, 180_000);

  test("publishable graduation requires an exact clean dev receipt and main-compatible lifecycle", () => {
    const publishable = generationRecord("publishable");
    const artifact = {
      id: "sample",
      version: "dev-1",
      payloadSha256: "1".repeat(64),
      lifecycle: "dynamic" as const,
      sdkRange: "^1.2.0",
    };
    const validation = {
      pluginIdentity: {
        id: "sample",
        version: "dev-1",
        payloadSha256: "1".repeat(64),
      },
      sdkRuntimeIdentity: {
        version: "1.2.1",
        sha256: "a".repeat(64),
      },
      target: TARGET,
    };
    expect(evaluatePublishableGraduation({
      generation: null,
      artifact,
      devValidation: validation,
      mainSdkRuntime: validation.sdkRuntimeIdentity,
    })).toMatchObject({
      ok: false,
      code: "develop.publishable-rebuild-required",
    });
    expect(evaluatePublishableGraduation({
      generation: publishable,
      artifact,
      devValidation: {
        ...validation,
        pluginIdentity: {
          ...validation.pluginIdentity,
          payloadSha256: "2".repeat(64),
        },
      },
      mainSdkRuntime: validation.sdkRuntimeIdentity,
    })).toMatchObject({
      ok: false,
      code: "develop.dev-revalidation-required",
    });
    expect(evaluatePublishableGraduation({
      generation: publishable,
      artifact: { ...artifact, lifecycle: "renderer-start" },
      devValidation: validation,
      mainSdkRuntime: validation.sdkRuntimeIdentity,
    })).toMatchObject({
      ok: false,
      code: "develop.main-transfer-ineligible",
    });
    expect(evaluatePublishableGraduation({
      generation: publishable,
      artifact,
      devValidation: validation,
      mainSdkRuntime: {
        ...validation.sdkRuntimeIdentity,
        sha256: "c".repeat(64),
      },
    })).toMatchObject({
      ok: false,
      code: "develop.main-transfer-ineligible",
    });
  });

  test("package rejects a forged publishable SDK label that does not match current runtime bytes", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-forged-sdk-label",
    });
    try {
      const built = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
        sdkInput: {
          kind: "publishable",
          version: "1.2.0",
          runtimeSha256: "f".repeat(64),
        },
      });
      expect(built.ok).toBe(true);
      const packaged = await packagePluginWorkspace({
        workspacePath: fixture.workspace,
        outputDir: join(fixture.root, "archives"),
        timeoutMs: 60_000,
      });
      expect(packaged).toMatchObject({
        ok: false,
        code: "plugin.package.stale",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
