import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  realpath,
  readdir,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type LocalSdkRuntimeIdentity = {
  version: string;
  sha256: string;
  declarationsSha256: string;
  runtimePath: string;
  declarationsPath: string;
};

export type ValidatedLocalSdkSource = {
  rootPath: string;
  identity: {
    packageName: "@explodex/sdk";
    version: string;
    runtimePath: string;
    declarationsPath: string;
  };
  runtime: LocalSdkRuntimeIdentity;
};

export type LocalSdkSourceValidationResult =
  | { ok: true; value: ValidatedLocalSdkSource; identity: ValidatedLocalSdkSource["identity"] }
  | { ok: false; code: "develop.sdk-source-invalid"; message: string };

export type LocalSdkBuildResult =
  | {
      ok: true;
      source: ValidatedLocalSdkSource;
      priorDistFingerprint: string | null;
      distFingerprintAfter: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      priorDistFingerprint: string | null;
      distFingerprintAfter: string | null;
      details?: Record<string, unknown>;
    };

type ExpectedOutputManifest = {
  schemaVersion: 1;
  sdkVersion: string;
  files: Record<string, { sha256: string; bytes: number }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

async function pathFingerprint(path: string): Promise<string | null> {
  try {
    const entries = await listFiles(path);
    const hash = createHash("sha256");
    for (const relativePath of entries) {
      const bytes = await readFile(join(path, relativePath));
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(bytes.byteLength));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\n");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix.length === 0
      ? entry.name
      : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`SDK output contains unsupported entry: ${relativePath}`);
    }
  }
  return files.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function parseExpectedOutput(value: unknown): ExpectedOutputManifest | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sdkVersion !== "string" ||
    !isRecord(value.files)
  ) return null;
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const [path, entry] of Object.entries(value.files)) {
    if (
      !isRecord(entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    ) return null;
    files[path] = { sha256: entry.sha256, bytes: entry.bytes };
  }
  return {
    schemaVersion: 1,
    sdkVersion: value.sdkVersion,
    files,
  };
}

function exportedPath(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function readDeclaredSdkVersion(source: string): string | null {
  const match = source.match(
    /export const SDK_VERSION = ["']([^"']+)["'](?: as const)?;/u,
  );
  return match?.[1] ?? null;
}

async function validateGeneratedOutputs(options: {
  rootPath: string;
  packageVersion: string;
}): Promise<
  | { ok: true; runtime: LocalSdkRuntimeIdentity }
  | { ok: false; message: string }
> {
  const distPath = join(options.rootPath, "dist");
  const runtimePath = join(
    distPath,
    "runtime",
    "explodex-runtime.iife.js",
  );
  const declarationsPath = join(distPath, "index.d.ts");
  let expected: ExpectedOutputManifest | null = null;
  try {
    expected = parseExpectedOutput(
      JSON.parse(
        await readFile(join(distPath, "expected-output.json"), "utf8"),
      ) as unknown,
    );
  } catch {
    // Classified below.
  }
  if (
    expected === null ||
    expected.sdkVersion !== options.packageVersion ||
    expected.files["runtime/explodex-runtime.iife.js"] === undefined ||
    expected.files["index.d.ts"] === undefined
  ) {
    return {
      ok: false,
      message:
        "Local SDK generated output manifest is missing, malformed, or version-mismatched.",
    };
  }
  const actualFiles = (await listFiles(distPath)).filter((path) =>
    path !== "expected-output.json"
  );
  const expectedFiles = Object.keys(expected.files).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  if (actualFiles.join("\0") !== expectedFiles.join("\0")) {
    return {
      ok: false,
      message:
        "Local SDK dist does not exactly match its generated output manifest.",
    };
  }
  for (const relativePath of expectedFiles) {
    const bytes = await readFile(join(distPath, relativePath));
    const record = expected.files[relativePath]!;
    if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
      return {
        ok: false,
        message: `Local SDK generated output drifted: ${relativePath}.`,
      };
    }
  }
  const runtimeBytes = await readFile(runtimePath);
  const declarationBytes = await readFile(declarationsPath);
  return {
    ok: true,
    runtime: {
      version: options.packageVersion,
      sha256: sha256(runtimeBytes),
      declarationsSha256: sha256(declarationBytes),
      runtimePath,
      declarationsPath,
    },
  };
}

/**
 * Validate one explicit canonical @explodex/sdk source workspace. This never
 * searches parent directories or ambient monorepo state.
 */
export async function validateLocalSdkSourceWorkspace(options: {
  sdkSourcePath: string;
  pluginWorkspacePath: string;
  explodexHome: string;
  devRootPath: string;
}): Promise<LocalSdkSourceValidationResult> {
  const requested = resolve(options.sdkSourcePath);
  let rootPath: string;
  try {
    const rootStats = await lstat(requested);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return {
        ok: false,
        code: "develop.sdk-source-invalid",
        message:
          "Local SDK source must be one real canonical source workspace.",
      };
    }
    rootPath = await realpath(requested);
  } catch {
    return {
      ok: false,
      code: "develop.sdk-source-invalid",
      message: "Local SDK source workspace is unavailable.",
    };
  }

  for (const overlap of [
    resolve(options.pluginWorkspacePath),
    resolve(options.explodexHome),
    resolve(options.devRootPath),
    "/Applications/ChatGPT.app",
  ]) {
    if (pathsOverlap(rootPath, overlap)) {
      return {
        ok: false,
        code: "develop.sdk-source-invalid",
        message:
          "Local SDK source overlaps the plugin, development instance, Explodex state, or canonical host.",
      };
    }
  }

  const required = [
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "src",
    "src/version.ts",
    "scripts/build.ts",
    "scripts/run-build.sh",
  ] as const;
  for (const relativePath of required) {
    try {
      const child = await realpath(join(rootPath, relativePath));
      if (!isWithin(rootPath, child)) throw new Error("escape");
    } catch {
      return {
        ok: false,
        code: "develop.sdk-source-invalid",
        message: `Local SDK source is missing or escapes: ${relativePath}.`,
      };
    }
  }

  let packageJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(
      await readFile(join(rootPath, "package.json"), "utf8"),
    ) as unknown;
    if (!isRecord(parsed)) throw new Error("not an object");
    packageJson = parsed;
  } catch {
    return {
      ok: false,
      code: "develop.sdk-source-invalid",
      message: "Local SDK source package.json is unreadable.",
    };
  }
  if (
    packageJson.name !== "@explodex/sdk" ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0 ||
    !isRecord(packageJson.exports) ||
    !isRecord(packageJson.exports["."]) ||
    !isRecord(packageJson.exports["./runtime"]) ||
    packageJson.types !== "./dist/index.d.ts" ||
    exportedPath(packageJson.exports["."], "types") !==
      "./dist/index.d.ts" ||
    exportedPath(packageJson.exports["."], "import") !==
      "./dist/index.js" ||
    exportedPath(packageJson.exports["./runtime"], "types") !==
      "./dist/runtime/public.d.ts" ||
    exportedPath(packageJson.exports["./runtime"], "browser") !==
      "./dist/runtime/explodex-runtime.iife.js"
  ) {
    return {
      ok: false,
      code: "develop.sdk-source-invalid",
      message:
        "Local SDK source must declare @explodex/sdk with public authoring and runtime exports.",
    };
  }
  const [sourceVersion, generatedVersion] = await Promise.all([
    readFile(join(rootPath, "src", "version.ts"), "utf8")
      .then(readDeclaredSdkVersion)
      .catch(() => null),
    readFile(join(rootPath, "dist", "version.js"), "utf8")
      .then(readDeclaredSdkVersion)
      .catch(() => null),
  ]);
  if (
    sourceVersion !== packageJson.version ||
    generatedVersion !== packageJson.version
  ) {
    return {
      ok: false,
      code: "develop.sdk-source-invalid",
      message:
        "Local SDK package, source, and generated runtime versions do not match.",
    };
  }

  const generated = await validateGeneratedOutputs({
    rootPath,
    packageVersion: packageJson.version,
  }).catch(() => ({
    ok: false as const,
    message: "Local SDK generated outputs are unavailable or invalid.",
  }));
  if (!generated.ok) {
    return {
      ok: false,
      code: "develop.sdk-source-invalid",
      message: generated.message,
    };
  }
  const value: ValidatedLocalSdkSource = {
    rootPath,
    identity: {
      packageName: "@explodex/sdk",
      version: packageJson.version,
      runtimePath: generated.runtime.runtimePath,
      declarationsPath: generated.runtime.declarationsPath,
    },
    runtime: generated.runtime,
  };
  return { ok: true, value, identity: value.identity };
}

export async function buildLocalSdkSource(options: {
  source: ValidatedLocalSdkSource;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<LocalSdkBuildResult> {
  const priorDistFingerprint = await pathFingerprint(
    join(options.source.rootPath, "dist"),
  );
  const scriptPath = join(options.source.rootPath, "scripts", "run-build.sh");
  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(scriptPath, [], {
      cwd: options.source.rootPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child close/error owns settlement.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, options.timeoutMs));
    const onAbort = (): void => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    };
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
  const distFingerprintAfter = await pathFingerprint(
    join(options.source.rootPath, "dist"),
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: options.signal?.aborted
        ? "operation.interrupted"
        : result.timedOut
          ? "operation.timeout"
          : "develop.sdk-build-failed",
      message: options.signal?.aborted
        ? "Local SDK build was interrupted."
        : result.timedOut
          ? "Local SDK build timed out."
          : "Local SDK typecheck, bundle, or generated-output validation failed.",
      priorDistFingerprint,
      distFingerprintAfter,
      details: {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 4_000),
        stderr: result.stderr.slice(0, 4_000),
      },
    };
  }
  const validated = await validateLocalSdkSourceWorkspace({
    sdkSourcePath: options.source.rootPath,
    pluginWorkspacePath: join(options.source.rootPath, "..", ".non-overlap"),
    explodexHome: join(options.source.rootPath, "..", ".non-overlap-home"),
    devRootPath: join(options.source.rootPath, "..", ".non-overlap-dev"),
  });
  if (!validated.ok || distFingerprintAfter === null) {
    return {
      ok: false,
      code: "develop.sdk-build-failed",
      message: validated.ok
        ? "Local SDK build produced no complete dist output."
        : validated.message,
      priorDistFingerprint,
      distFingerprintAfter,
    };
  }
  return {
    ok: true,
    source: validated.value,
    priorDistFingerprint,
    distFingerprintAfter,
  };
}
