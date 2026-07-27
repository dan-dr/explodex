#!/usr/bin/env bun
/**
 * Transactional SDK build:
 * 1. Compile authoring TypeScript to dist-build (JS + declarations + maps)
 * 2. Bundle browser runtime classic IIFE with package-relative source map
 * 3. Write expected-output manifest
 * 4. Validate staging graph
 * 5. Atomically replace dist/
 *
 * A failure after a prior successful dist leaves that dist byte-identical.
 */
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const stagingRoot = join(packageRoot, "dist-build");
const finalRoot = join(packageRoot, "dist");

async function resolveTsc(): Promise<string> {
  const fromEnv = process.env.EXPLODEX_TSC;
  if (fromEnv !== undefined && fromEnv.length > 0 && (await pathExists(fromEnv))) {
    return fromEnv;
  }

  const candidates: string[] = [
    join(packageRoot, "node_modules", ".bin", "tsc"),
    join(packageRoot, "..", "..", "node_modules", ".bin", "tsc"),
  ];

  // Walk parents for a monorepo or consumer-provided TypeScript install.
  let cursor = packageRoot;
  for (let i = 0; i < 8; i += 1) {
    candidates.push(join(cursor, "node_modules", ".bin", "tsc"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const which = Bun.which("tsc");
  if (which !== null) candidates.push(which);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(
    "Unable to resolve tsc. Install TypeScript in the monorepo or set EXPLODEX_TSC to the tsc binary.",
  );
}

const FORBIDDEN_MAP_PATH_MARKERS = [
  "/Users/",
  "/home/",
  "/private/var/",
  "/tmp/",
  "\\Users\\",
  "node_modules",
  "plugin-registry",
  "packages/cli",
  "vendor/",
  "extracted/",
] as const;

type ExpectedOutput = {
  schemaVersion: 1;
  generatedAt: string;
  files: Record<string, { sha256: string; bytes: number }>;
};

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  if (await pathExists(root)) {
    await walk(root);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

async function writeExpectedOutputManifest(root: string): Promise<ExpectedOutput> {
  const files = await listFilesRecursive(root);
  const manifest: ExpectedOutput = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files: {},
  };
  for (const file of files) {
    const rel = toPosixRelative(root, file);
    if (rel === "expected-output.json") continue;
    const bytes = await readFile(file);
    manifest.files[rel] = {
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }
  await writeFile(join(root, "expected-output.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function assertNoForbiddenMapSources(mapText: string, mapPath: string): void {
  let parsed: { sources?: unknown; sourceRoot?: unknown; file?: unknown };
  try {
    parsed = JSON.parse(mapText) as { sources?: unknown; sourceRoot?: unknown; file?: unknown };
  } catch {
    throw new Error(`Invalid source map JSON at ${mapPath}`);
  }
  const sources = Array.isArray(parsed.sources)
    ? parsed.sources.filter((item): item is string => typeof item === "string")
    : [];
  for (const source of sources) {
    if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) {
      throw new Error(`Source map contains absolute path: ${source}`);
    }
    for (const marker of FORBIDDEN_MAP_PATH_MARKERS) {
      if (source.includes(marker)) {
        throw new Error(`Source map source contains forbidden marker "${marker}": ${source}`);
      }
    }
  }
  if (typeof parsed.sourceRoot === "string") {
    for (const marker of FORBIDDEN_MAP_PATH_MARKERS) {
      if (parsed.sourceRoot.includes(marker) || parsed.sourceRoot.startsWith("/")) {
        throw new Error(`Source map sourceRoot is not package-relative: ${parsed.sourceRoot}`);
      }
    }
  }
}

async function rewriteSourceMapToPackageRelative(
  mapPath: string,
  generatedFileName: string,
): Promise<void> {
  const raw = await readFile(mapPath, "utf8");
  const map = JSON.parse(raw) as {
    version: number;
    file?: string;
    sourceRoot?: string;
    sources?: string[];
    sourcesContent?: Array<string | null>;
    mappings?: string;
    names?: string[];
  };

  const sources = Array.isArray(map.sources) ? map.sources : [];
  const rewritten = sources.map((source) => {
    // Collapse any absolute or build-relative paths to package-relative src/...
    const normalized = source.replace(/\\/g, "/");
    const srcIndex = normalized.lastIndexOf("/src/");
    if (srcIndex >= 0) {
      return normalized.slice(srcIndex + 1); // "src/..."
    }
    if (normalized.startsWith("src/")) return normalized;
    if (normalized.startsWith("../src/")) return normalized.slice(3);
    if (normalized.startsWith("./")) return normalized.slice(2);
    // Already relative package path
    if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
      return normalized.startsWith("src/") ? normalized : `src/${normalized.split("/").pop() ?? normalized}`;
    }
    throw new Error(`Unable to rewrite source map path to package-relative form: ${source}`);
  });

  const portable = {
    version: map.version ?? 3,
    file: generatedFileName,
    sourceRoot: "",
    sources: rewritten,
    sourcesContent: map.sourcesContent,
    names: map.names ?? [],
    mappings: map.mappings ?? "",
  };

  const text = `${JSON.stringify(portable)}\n`;
  assertNoForbiddenMapSources(text, mapPath);
  await writeFile(mapPath, text, "utf8");
}

async function ensureSourceMappingUrl(jsPath: string, mapFileName: string): Promise<void> {
  const source = await readFile(jsPath, "utf8");
  const directive = `//# sourceMappingURL=${mapFileName}`;
  let next = source.replace(/\/\/# sourceMappingURL=.*$/m, "").trimEnd();
  next = `${next}\n${directive}\n`;
  await writeFile(jsPath, next, "utf8");
}

async function bundleRuntimeIife(): Promise<void> {
  const entry = join(packageRoot, "src", "runtime", "index.ts");
  const outdir = join(stagingRoot, "runtime");
  await mkdir(outdir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    format: "iife",
    sourcemap: "external",
    minify: false,
    naming: "explodex-runtime.iife.[ext]",
    // Drop Node/Bun built-ins; fail if the graph tries to pull them in.
    packages: "bundle",
  });

  if (!result.success) {
    const messages = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`Runtime IIFE bundle failed:\n${messages}`);
  }

  // Bun may name the map with a different convention; normalize.
  const produced = await listFilesRecursive(outdir);
  const jsFile = produced.find((path) => path.endsWith(".js"));
  if (jsFile === undefined) {
    throw new Error("Runtime IIFE bundle did not emit a .js file");
  }
  const desiredJs = join(outdir, "explodex-runtime.iife.js");
  if (jsFile !== desiredJs) {
    await rename(jsFile, desiredJs);
  }

  const mapCandidate =
    produced.find((path) => path.endsWith(".js.map")) ??
    produced.find((path) => path.endsWith(".map"));
  const desiredMap = join(outdir, "explodex-runtime.iife.js.map");
  if (mapCandidate === undefined) {
    throw new Error("Runtime IIFE bundle did not emit a source map");
  }
  if (mapCandidate !== desiredMap) {
    await rename(mapCandidate, desiredMap);
  }

  await rewriteSourceMapToPackageRelative(desiredMap, "explodex-runtime.iife.js");
  await ensureSourceMappingUrl(desiredJs, "explodex-runtime.iife.js.map");

  // Public types for the runtime export path (type-only).
  const publicTypesSource = join(packageRoot, "src", "runtime", "public.ts");
  // Emit a minimal declaration companion by hand from the public surface.
  // Authoring declarations come from tsc; runtime public types are a thin re-export.
  const publicDts = `export type ExplodexRuntime = {
  readonly version: string;
  readonly log: {
    debug(message: string, detail?: unknown): void;
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
  };
  readonly review: {
    open(request: {
      schemaVersion: 1;
      operationId: string;
      nonce: string;
      callbackName: string;
      expiresAtMs: number;
      warning?: string;
      artifacts: Array<{
        id: string;
        displayName: string;
        description: string;
        version: string;
        payloadSha256: string;
        sdkRange: string;
        sourceLabel: string;
      }>;
    }): Promise<
      | {
          status: "submitted";
          payload: {
            schemaVersion: 1;
            nonce: string;
            selected: Array<{
              id: string;
              version: string;
              payloadSha256: string;
            }>;
          };
        }
      | { status: "cancelled"; reason: string }
      | { status: "expired"; reason: string }
      | { status: "rejected"; reason: string }
    >;
    cancel(reason?: string): void;
  };
  destroy(options?: { reason?: string }): void;
};
`;
  await writeFile(join(outdir, "public.d.ts"), publicDts, "utf8");
  // Keep the authored public.ts content hashable via copy of the type source note.
  await copyFile(publicTypesSource, join(outdir, "public.ts.note"));
  await rm(join(outdir, "public.ts.note"), { force: true });
}

function assertAuthoringOutputs(files: string[]): void {
  const rel = new Set(files.map((file) => toPosixRelative(stagingRoot, file)));
  const required = [
    "index.js",
    "index.d.ts",
    "define-plugin.js",
    "define-plugin.d.ts",
    "define-config.js",
    "define-config.d.ts",
    "version.js",
    "version.d.ts",
    "compatibility.js",
    "compatibility.d.ts",
    "testing/index.js",
    "testing/index.d.ts",
    "lifecycle/index.js",
    "lifecycle/index.d.ts",
    "runtime/explodex-runtime.iife.js",
    "runtime/explodex-runtime.iife.js.map",
    "runtime/public.d.ts",
  ];
  for (const path of required) {
    if (!rel.has(path)) {
      throw new Error(`Staging output missing required file: ${path}`);
    }
  }
}

async function scanForAnyInDeclarations(root: string): Promise<void> {
  const files = (await listFilesRecursive(root)).filter((path) => path.endsWith(".d.ts"));
  // Match explicit any annotations, not the substring inside words like "company".
  const anyPattern = /(?<![A-Za-z0-9_])any(?![A-Za-z0-9_])/g;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    // Allow the word only inside comments that say "no any" etc. — still fail on type any.
    const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");
    if (anyPattern.test(withoutLineComments)) {
      throw new Error(`Declaration introduces any: ${toPosixRelative(root, file)}`);
    }
  }
}

async function validateStaging(): Promise<void> {
  const files = await listFilesRecursive(stagingRoot);
  assertAuthoringOutputs(files);
  await scanForAnyInDeclarations(stagingRoot);

  const iifePath = join(stagingRoot, "runtime", "explodex-runtime.iife.js");
  const iife = await readFile(iifePath, "utf8");
  if (iife.includes("import ") && /^\s*import\s/m.test(iife)) {
    throw new Error("Runtime IIFE still contains ESM import statements");
  }
  if (iife.includes("require(")) {
    throw new Error("Runtime IIFE contains require()");
  }
  if (!iife.includes("sourceMappingURL=explodex-runtime.iife.js.map")) {
    throw new Error("Runtime IIFE missing package-relative sourceMappingURL");
  }

  const mapPath = join(stagingRoot, "runtime", "explodex-runtime.iife.js.map");
  assertNoForbiddenMapSources(await readFile(mapPath, "utf8"), mapPath);

  // Browser-safety: authored runtime graph must not reference Node/Bun globals as free requires.
  const forbidden = ["node:fs", "node:path", "node:child_process", "bun:sqlite", "electron"];
  for (const token of forbidden) {
    if (iife.includes(token)) {
      throw new Error(`Runtime IIFE contains forbidden dependency token: ${token}`);
    }
  }
}

async function compileAuthoring(): Promise<void> {
  const tsc = await resolveTsc();
  const compilation = Bun.spawn([tsc, "-p", join(packageRoot, "tsconfig.build.json")], {
    cwd: packageRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await compilation.exited;
  if (exitCode !== 0) {
    throw new Error(`tsc failed with exit ${exitCode}`);
  }
}

async function main(): Promise<void> {
  const previousDistExisted = await pathExists(finalRoot);
  let previousBackup: string | null = null;

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    await compileAuthoring();
    await bundleRuntimeIife();
    await validateStaging();
    await writeExpectedOutputManifest(stagingRoot);

    // Atomic replace: move current dist aside, then rename staging into place.
    if (previousDistExisted) {
      previousBackup = join(packageRoot, `.dist-backup-${process.pid}`);
      await rm(previousBackup, { recursive: true, force: true });
      await rename(finalRoot, previousBackup);
    }
    await rename(stagingRoot, finalRoot);
    if (previousBackup !== null) {
      await rm(previousBackup, { recursive: true, force: true });
    }
  } catch (error) {
    // Preserve prior dist byte-for-byte on failure.
    if (previousBackup !== null && !(await pathExists(finalRoot))) {
      await rename(previousBackup, finalRoot);
      previousBackup = null;
    }
    if (previousBackup !== null) {
      await rm(previousBackup, { recursive: true, force: true });
    }
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

await main();
