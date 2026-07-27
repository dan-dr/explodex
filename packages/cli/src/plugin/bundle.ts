/**
 * Browser-safe plugin bundling into one classic-script IIFE.
 * Rejects direct/transitive Node/Bun/Electron/server-only chains and private globals.
 * Uses esbuild (Node-compatible); does not require Bun at runtime.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { scanBrowserSafeIife } from "./browser-scan.ts";
import { validatePluginSourceMapV3 } from "./source-map.ts";

export type BundleImportDiagnostic = {
  readonly specifier: string;
  readonly importer: string;
  readonly chain: readonly string[];
  readonly reason: string;
};

export type BundleSuccess = {
  ok: true;
  pluginId: string;
  entryRelative: string;
  jsRelative: "index.js";
  mapRelative: "index.js.map";
  jsBytes: number;
  jsSha256: string;
  mapBytes: number;
  diagnostics: readonly BundleImportDiagnostic[];
};

export type BundleFailure = {
  ok: false;
  code: string;
  message: string;
  diagnostics: readonly BundleImportDiagnostic[];
  details?: Record<string, unknown>;
};

export type BundleResult = BundleSuccess | BundleFailure;

const FORBIDDEN_BARE_MODULES = new Set([
  "fs",
  "fs/promises",
  "path",
  "os",
  "child_process",
  "worker_threads",
  "cluster",
  "net",
  "tls",
  "http",
  "https",
  "http2",
  "dns",
  "dgram",
  "readline",
  "repl",
  "vm",
  "v8",
  "module",
  "assert",
  "async_hooks",
  "perf_hooks",
  "trace_events",
  "inspector",
  "diagnostics_channel",
  "stream",
  "stream/promises",
  "stream/web",
  "buffer",
  "crypto",
  "zlib",
  "util",
  "url",
  "querystring",
  "punycode",
  "string_decoder",
  "timers",
  "timers/promises",
  "console",
  "process",
  "events",
  "constants",
  "domain",
  "tty",
  "electron",
  "bun",
]);

const FORBIDDEN_PREFIXES = [
  "node:",
  "bun:",
  "fs/",
  "node-fetch",
  "electron/",
] as const;

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isForbiddenSpecifier(specifier: string): string | null {
  if (specifier.startsWith("node:")) {
    return "Node built-in module";
  }
  if (specifier.startsWith("bun:")) {
    return "Bun built-in module";
  }
  if (specifier === "electron" || specifier.startsWith("electron/")) {
    return "Electron runtime module";
  }
  if (FORBIDDEN_BARE_MODULES.has(specifier)) {
    return "Node/server-only runtime module";
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return `Forbidden runtime module prefix "${prefix}"`;
    }
  }
  return null;
}

function buildSdkShim(pluginId: string): string {
  // Thin browser-safe authoring surface for the plugin graph.
  // Host registration is performed by the IIFE footer, not here.
  return `
export function definePlugin(definition) {
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("definePlugin requires a plugin definition object");
  }
  if (typeof definition.setup !== "function") {
    throw new TypeError("definePlugin requires setup(api)");
  }
  for (const key of Object.keys(definition)) {
    if (key !== "setup") {
      throw new TypeError('definePlugin does not accept unknown field "' + key + '"');
    }
  }
  return Object.freeze({
    setup: definition.setup,
    __explodexDefinedPlugin: true,
  });
}
export function isDefinedPlugin(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.__explodexDefinedPlugin === true &&
    typeof value.setup === "function"
  );
}
export function defineConfig() {
  throw new Error("defineConfig is not available inside a plugin runtime bundle");
}
export const SDK_VERSION = ${JSON.stringify("bundled")};
export function satisfiesSdkRange() { return true; }
export function evaluateSdkCompatibility() {
  return { ok: true, reason: "bundled-shim" };
}
export function compareSemVer() { return 0; }
export function parseSemVer() { return null; }
export function currentSdkSatisfiesRange() { return true; }
// Keep plugin id available for diagnostics without embedding host APIs.
export const __EXPLODEX_BUNDLE_PLUGIN_ID__ = ${JSON.stringify(pluginId)};
`;
}

function iifeFooter(pluginId: string, globalName: string): string {
  return `
;(function (global) {
  var exported = typeof ${globalName} !== "undefined" ? ${globalName} : undefined;
  var definition = exported;
  if (definition && typeof definition === "object" && "default" in definition) {
    definition = definition.default;
  }
  var register = global && global.__EXPLODEX_PRIVATE_REGISTER__;
  if (typeof register === "function") {
    register(${JSON.stringify(pluginId)}, definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bundle a plugin entry into a classic-script IIFE written under stagingDir.
 * Does not commit dist/; caller performs transactional replacement.
 */
export async function bundlePluginIife(options: {
  workspacePath: string;
  entryRelative: string;
  pluginId: string;
  stagingDir: string;
  /** When true, write index.js + index.js.map into stagingDir. */
  writeOutputs?: boolean;
}): Promise<BundleResult> {
  const workspacePath = resolve(options.workspacePath);
  const entryAbsolute = resolve(workspacePath, options.entryRelative);
  const stagingDir = resolve(options.stagingDir);
  const diagnostics: BundleImportDiagnostic[] = [];
  const writeOutputs = options.writeOutputs !== false;

  if (!(await pathExists(entryAbsolute))) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: `Entry file is missing: ${options.entryRelative}`,
      diagnostics,
      details: { entry: options.entryRelative },
    };
  }

  const globalName = "__ExplodexPluginBundle";
  // Fixed virtual path so installable JS bytes do not embed absolute workspace/staging paths.
  const shimVirtualPath = "explodex-sdk-shim.js";
  const shimSource = buildSdkShim(options.pluginId);
  await mkdir(stagingDir, { recursive: true });
  const workspaceCanonical = await realpath(workspacePath);

  const importerChain = new Map<string, string[]>();

  try {
    const outJsPath = join(stagingDir, "index.js");
    const result = await esbuild.build({
      absWorkingDir: workspacePath,
      entryPoints: [entryAbsolute],
      bundle: true,
      write: true,
      outfile: outJsPath,
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      globalName,
      sourcemap: "external",
      // Avoid absolute path comments leaking into installable bytes.
      legalComments: "none",
      logLevel: "silent",
      // Keep the graph browser-only; fail on Node packages rather than polyfilling.
      packages: "bundle",
      // Reject dynamic import() expressions used for unresolved loading.
      supported: {
        "dynamic-import": false,
      },
      plugins: [
        {
          name: "explodex-sdk-shim",
          setup(build) {
            build.onResolve({ filter: /^@explodex\/sdk(\/.*)?$/ }, (args) => {
              if (args.path === "@explodex/sdk" || args.path === "@explodex/sdk/runtime") {
                return { path: shimVirtualPath, namespace: "explodex-sdk-shim" };
              }
              diagnostics.push({
                specifier: args.path,
                importer: args.importer || options.entryRelative,
                chain: [args.importer || options.entryRelative, args.path],
                reason: "Non-public @explodex/sdk import is not allowed in plugin bundles",
              });
              return {
                errors: [
                  {
                    text: `Non-public @explodex/sdk import is not allowed: ${args.path}`,
                  },
                ],
              };
            });

            build.onLoad({ filter: /.*/, namespace: "explodex-sdk-shim" }, () => ({
              contents: shimSource,
              loader: "js",
              resolveDir: workspacePath,
            }));

            build.onResolve({ filter: /.*/ }, (args) => {
              // Track importer chains for diagnostics.
              const parentChain = importerChain.get(args.importer) ?? [args.importer || options.entryRelative];
              const chain = [...parentChain, args.path];
              importerChain.set(args.path, chain);

              if (args.kind === "dynamic-import") {
                diagnostics.push({
                  specifier: args.path,
                  importer: args.importer || options.entryRelative,
                  chain,
                  reason: "Unresolved dynamic loading is not allowed in plugin bundles",
                });
                return {
                  errors: [
                    {
                      text: `Dynamic import is not allowed in plugin bundles: ${args.path} (from ${args.importer || options.entryRelative})`,
                    },
                  ],
                };
              }

              const forbidden = isForbiddenSpecifier(args.path);
              if (forbidden !== null) {
                diagnostics.push({
                  specifier: args.path,
                  importer: args.importer || options.entryRelative,
                  chain,
                  reason: forbidden,
                });
                return {
                  errors: [
                    {
                      text: `${forbidden}: ${args.path} imported from ${args.importer || options.entryRelative}`,
                    },
                  ],
                };
              }
              return null;
            });
          },
        },
      ],
    });

    if (result.errors.length > 0) {
      const messages = result.errors.map((error) => {
        const location = error.location
          ? `${error.location.file}:${error.location.line}:${error.location.column}`
          : "unknown";
        return `${error.text} (${location})`;
      });
      // Promote esbuild unresolved import messages into diagnostics.
      for (const error of result.errors) {
        const match = /Could not resolve "([^"]+)"/.exec(error.text);
        if (match) {
          const specifier = match[1]!;
          diagnostics.push({
            specifier,
            importer: error.location?.file
              ? toPosix(relative(workspacePath, error.location.file))
              : options.entryRelative,
            chain: importerChain.get(specifier) ?? [options.entryRelative, specifier],
            reason: "Unresolved module",
          });
        }
      }
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: `Plugin bundle failed: ${messages[0] ?? "unknown bundler error"}`,
        diagnostics,
        details: {
          errors: messages,
          diagnostics,
        },
      };
    }

    if (!(await pathExists(outJsPath))) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Plugin bundle did not emit index.js",
        diagnostics,
      };
    }

    let jsText = (await readFile(outJsPath, "utf8")) + iifeFooter(options.pluginId, globalName);
    const mapPath = join(stagingDir, "index.js.map");
    const mapRaw = (await pathExists(mapPath)) ? await readFile(mapPath, "utf8") : "";

    const browserSafety = scanBrowserSafeIife(jsText);
    if (!browserSafety.ok) {
      diagnostics.push({
        specifier: browserSafety.marker,
        importer: options.entryRelative,
        chain: [options.entryRelative, browserSafety.marker],
        reason: browserSafety.message,
      });
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: browserSafety.message,
        diagnostics,
        details: {
          browserSafety,
        },
      };
    }

    if (mapRaw.length === 0) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Plugin bundle did not emit the required V3 source map",
        diagnostics,
      };
    }
    let mapText: string;
    try {
      const parsed = JSON.parse(mapRaw) as {
        version?: unknown;
        sources?: unknown;
        sourcesContent?: unknown;
        mappings?: unknown;
        names?: unknown;
      };
      if (
        parsed.version !== 3 ||
        !Array.isArray(parsed.sources) ||
        !parsed.sources.every((source) => typeof source === "string") ||
        !Array.isArray(parsed.sourcesContent) ||
        parsed.sourcesContent.length !== parsed.sources.length ||
        !parsed.sourcesContent.every((content) => typeof content === "string") ||
        typeof parsed.mappings !== "string" ||
        !Array.isArray(parsed.names) ||
        !parsed.names.every((name) => typeof name === "string")
      ) {
        throw new Error("Bundler source map does not have the required V3 fields");
      }
      const rewritten = await Promise.all(parsed.sources.map((source, index) =>
        portableTypeScriptSourcePath({
          source,
          index,
          workspacePath: workspaceCanonical,
          stagingDir,
        })
      ));
      mapText = `${JSON.stringify({
        version: 3,
        file: "index.js",
        sourceRoot: "",
        sources: rewritten,
        sourcesContent: parsed.sourcesContent,
        names: parsed.names,
        mappings: parsed.mappings,
      })}\n`;
    } catch (error: unknown) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: error instanceof Error
          ? `Plugin source map generation failed: ${error.message}`
          : "Plugin source map generation failed",
        diagnostics,
      };
    }

    if (!jsText.includes("sourceMappingURL=")) {
      jsText = `${jsText.trimEnd()}\n//# sourceMappingURL=index.js.map\n`;
    } else {
      jsText = jsText.replace(/\/\/# sourceMappingURL=.*$/m, "//# sourceMappingURL=index.js.map");
      if (!jsText.endsWith("\n")) jsText += "\n";
    }

    const sourceMapValidation = validatePluginSourceMapV3({
      mapText,
      generatedSource: jsText,
    });
    if (!sourceMapValidation.ok) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: sourceMapValidation.message,
        diagnostics,
        details: sourceMapValidation.details,
      };
    }

    // Final guard: installable JS must not embed absolute workspace paths.
    if (jsText.includes(workspacePath) || jsText.includes(stagingDir)) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Plugin bundle embedded non-portable absolute paths",
        diagnostics,
      };
    }

    if (writeOutputs) {
      await writeFile(join(stagingDir, "index.js"), jsText, "utf8");
      await writeFile(join(stagingDir, "index.js.map"), mapText, "utf8");
    }

    const jsBytes = Buffer.byteLength(jsText, "utf8");
    return {
      ok: true,
      pluginId: options.pluginId,
      entryRelative: options.entryRelative,
      jsRelative: "index.js",
      mapRelative: "index.js.map",
      jsBytes,
      jsSha256: sha256Hex(jsText),
      mapBytes: Buffer.byteLength(mapText, "utf8"),
      diagnostics,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Plugin bundle failed";
    return {
      ok: false,
      code: "plugin.source.invalid",
      message,
      diagnostics,
      details: { diagnostics },
    };
  }
}

async function portableTypeScriptSourcePath(options: {
  source: string;
  index: number;
  workspacePath: string;
  stagingDir: string;
}): Promise<string> {
  const normalized = options.source.replace(/\\/g, "/");
  if (normalized.includes("explodex-sdk-shim")) {
    return "src/.explodex/sdk-shim.ts";
  }
  const decoded = normalized.startsWith("file://")
    ? decodeURIComponent(normalized.replace(/^file:\/\//, ""))
    : normalized;
  const unresolvedSource = decoded.startsWith("/")
    ? decoded
    : resolve(options.stagingDir, decoded);
  const sourceAbsolute = await realpath(unresolvedSource);
  const relativeSource = toPosix(relative(options.workspacePath, sourceAbsolute));
  if (
    !relativeSource.startsWith("../") &&
    !relativeSource.startsWith("/") &&
    /^src\/.+\.tsx?$/u.test(relativeSource)
  ) {
    return relativeSource;
  }
  const nodeModulesMarker = "/node_modules/";
  const normalizedAbsolute = sourceAbsolute.replace(/\\/g, "/");
  const nodeModulesIndex = normalizedAbsolute.lastIndexOf(nodeModulesMarker);
  if (nodeModulesIndex >= 0) {
    const dependencyPath = normalizedAbsolute.slice(
      nodeModulesIndex + nodeModulesMarker.length,
    );
    const withoutExtension = dependencyPath.replace(/\.[A-Za-z0-9]+$/u, "");
    return `src/.explodex/dependencies/${withoutExtension || `source-${options.index}`}.ts`;
  }
  throw new Error(`Source map contains a non-package TypeScript source: ${options.source}`);
}

/**
 * Fingerprint a dist directory for prior-dist preservation checks.
 * Hashes the complete dist tree (installable + private generation metadata).
 */
export async function fingerprintDist(workspacePath: string): Promise<string | null> {
  const { fingerprintDistTree } = await import("./dist-files.ts");
  return fingerprintDistTree(workspacePath);
}

/**
 * Transactionally replace workspace dist/ with staging contents for bundle outputs.
 * On failure, caller must not call this. Prior dist remains until this succeeds.
 */
export async function commitBundleDist(options: {
  workspacePath: string;
  stagingDir: string;
}): Promise<void> {
  const workspacePath = resolve(options.workspacePath);
  const distPath = join(workspacePath, "dist");
  const stagingDir = resolve(options.stagingDir);
  const backup = join(workspacePath, `.dist-backup-${process.pid}`);

  const hadDist = await pathExists(distPath);
  if (hadDist) {
    await rm(backup, { recursive: true, force: true });
    await rename(distPath, backup);
  }
  try {
    await mkdir(dirname(distPath), { recursive: true });
    await rename(stagingDir, distPath);
    if (hadDist) {
      await rm(backup, { recursive: true, force: true });
    }
  } catch (error) {
    if (hadDist && !(await pathExists(distPath)) && (await pathExists(backup))) {
      await rename(backup, distPath);
    }
    throw error;
  }
}

/** Virtual module URL helper for tests. */
export function shimModuleUrl(pluginId: string): string {
  return pathToFileURL(`/explodex-sdk-shim/${pluginId}.js`).href;
}
