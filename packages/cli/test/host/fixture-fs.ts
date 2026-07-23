import { createHash } from "node:crypto";
import { dirname, join, normalize, sep } from "node:path";
import type {
  ExecResult,
  HostAdapters,
  HostClock,
  HostFileSystem,
  HostHash,
  HostProcess,
} from "../../src/host/adapters.ts";
import {
  CANONICAL_BUNDLE_ID,
  CANONICAL_BUNDLE_PATH,
  CANONICAL_EXECUTABLE_NAME,
  CANONICAL_SIGNING_TEAM,
  COMPATIBILITY_HOST_HASH_RELATIVE_PATHS,
  MISSION_BASELINE_APP_BUILD,
  MISSION_BASELINE_APP_VERSION,
} from "../../src/host/constants.ts";

type Entry =
  | { kind: "file"; content: Uint8Array; mode?: number }
  | { kind: "directory"; mode?: number }
  | { kind: "symlink"; target: string };

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function norm(path: string): string {
  if (path === sep) return path;
  const n = normalize(path);
  return n.endsWith(sep) && n.length > 1 ? n.slice(0, -1) : n;
}

export type VirtualHostBundleOptions = {
  bundlePath?: string;
  bundleId?: string;
  executableName?: string;
  appVersion?: string;
  appBuild?: string;
  signingTeam?: string;
  /** When set, executable file is stored at this absolute path instead of the default. */
  executableAbsolutePath?: string;
  /** Extra files under the bundle (relative path -> content). */
  extraFiles?: Record<string, string | Uint8Array>;
  /** Omit standard structure pieces. */
  omit?: Array<"contents" | "infoPlist" | "macos" | "executable">;
  /** Info.plist bytes override. */
  infoPlistContent?: string | Uint8Array;
  /** Executable bytes override. */
  executableContent?: string | Uint8Array;
  /** realpath mapping overrides. */
  realpathMap?: Record<string, string>;
  /** Make codesign fail / return empty team. */
  codesignBroken?: boolean;
};

export function defaultCanonicalBundleOptions(
  overrides: VirtualHostBundleOptions = {},
): Required<
  Pick<
    VirtualHostBundleOptions,
    | "bundlePath"
    | "bundleId"
    | "executableName"
    | "appVersion"
    | "appBuild"
    | "signingTeam"
  >
> &
  VirtualHostBundleOptions {
  return {
    bundlePath: CANONICAL_BUNDLE_PATH,
    bundleId: CANONICAL_BUNDLE_ID,
    executableName: CANONICAL_EXECUTABLE_NAME,
    appVersion: MISSION_BASELINE_APP_VERSION,
    appBuild: MISSION_BASELINE_APP_BUILD,
    signingTeam: CANONICAL_SIGNING_TEAM,
    ...overrides,
  };
}

export function buildInfoPlist(options: {
  bundleId: string;
  executableName: string;
  appVersion: string;
  appBuild: string;
}): string {
  // Minimal XML plist sufficient for plutil -extract in production;
  // the virtual process adapter parses these keys directly.
  return [
    `CFBundleIdentifier=${options.bundleId}`,
    `CFBundleExecutable=${options.executableName}`,
    `CFBundleShortVersionString=${options.appVersion}`,
    `CFBundleVersion=${options.appBuild}`,
  ].join("\n");
}

export class MemoryFileSystem implements HostFileSystem {
  readonly entries = new Map<string, Entry>();
  readonly realpathOverrides = new Map<string, string>();
  readonly writeLog: Array<{ path: string; bytes: number }> = [];

  seedFile(path: string, content: string | Uint8Array, mode = 0o644): void {
    const p = norm(path);
    this.ensureParentDirs(p);
    this.entries.set(p, {
      kind: "file",
      content: typeof content === "string" ? enc(content) : content,
      mode,
    });
  }

  seedDir(path: string, mode = 0o755): void {
    const p = norm(path);
    this.ensureParentDirs(p);
    this.entries.set(p, { kind: "directory", mode });
  }

  seedSymlink(path: string, target: string): void {
    const p = norm(path);
    this.ensureParentDirs(p);
    this.entries.set(p, { kind: "symlink", target });
  }

  setRealpath(from: string, to: string): void {
    this.realpathOverrides.set(norm(from), norm(to));
  }

  private ensureParentDirs(path: string): void {
    let current = dirname(path);
    const root = path.startsWith(sep) ? sep : "";
    while (current && current !== "." && current !== root) {
      const existing = this.entries.get(current);
      if (!existing) {
        this.entries.set(current, { kind: "directory", mode: 0o755 });
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (root === sep && !this.entries.has(sep)) {
      this.entries.set(sep, { kind: "directory", mode: 0o755 });
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.entries.has(norm(path));
  }

  async stat(path: string) {
    const entry = this.entries.get(norm(path));
    if (!entry) return { kind: "missing" as const };
    if (entry.kind === "file") return { kind: "file" as const, mode: entry.mode, size: entry.content.byteLength };
    if (entry.kind === "directory") return { kind: "directory" as const, mode: entry.mode };
    return { kind: "symlink" as const };
  }

  async realpath(path: string): Promise<string> {
    const p = norm(path);
    if (this.realpathOverrides.has(p)) {
      return this.realpathOverrides.get(p) as string;
    }
    const entry = this.entries.get(p);
    if (!entry) {
      throw new Error(`ENOENT: ${p}`);
    }
    if (entry.kind === "symlink") {
      return this.realpath(entry.target);
    }
    return p;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.entries.get(norm(path));
    if (!entry || entry.kind !== "file") {
      throw new Error(`ENOENT file: ${path}`);
    }
    return entry.content;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? enc(data) : data;
    this.writeLog.push({ path: norm(path), bytes: bytes.byteLength });
    this.seedFile(path, bytes, 0o600);
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    void options;
    this.seedDir(path, options?.mode ?? 0o700);
  }

  async rename(from: string, to: string): Promise<void> {
    const src = norm(from);
    const dest = norm(to);
    const entry = this.entries.get(src);
    if (!entry) throw new Error(`ENOENT rename from ${from}`);
    this.entries.delete(src);
    this.entries.set(dest, entry);
  }

  async readText(path: string): Promise<string> {
    const bytes = await this.readFile(path);
    return new TextDecoder().decode(bytes);
  }
}

export class VirtualProcess implements HostProcess {
  constructor(
    private readonly options: {
      bundles: Map<
        string,
        {
          plist: Record<string, string>;
          signingTeam: string | null;
          codesignBroken?: boolean;
        }
      >;
    },
  ) {}

  async execFile(file: string, args: readonly string[]): Promise<ExecResult> {
    if (file === "plutil") {
      // plutil -extract KEY raw -o - PATH
      const extractIdx = args.indexOf("-extract");
      const path = args[args.length - 1] ?? "";
      const key = extractIdx >= 0 ? args[extractIdx + 1] : "";
      for (const [bundlePath, meta] of this.options.bundles) {
        const infoPath = join(bundlePath, "Contents", "Info.plist");
        if (norm(path) === norm(infoPath)) {
          const value = meta.plist[key];
          if (value === undefined) {
            return { stdout: "", stderr: `no value for ${key}`, exitCode: 1 };
          }
          return { stdout: `${value}\n`, stderr: "", exitCode: 0 };
        }
      }
      return { stdout: "", stderr: `plutil: file not found ${path}`, exitCode: 1 };
    }

    if (file === "codesign") {
      const bundlePath = args[args.length - 1] ?? "";
      for (const [path, meta] of this.options.bundles) {
        if (norm(bundlePath) === norm(path) || norm(bundlePath) === norm(path)) {
          if (meta.codesignBroken) {
            return { stdout: "", stderr: "codesign failed", exitCode: 1 };
          }
          const team = meta.signingTeam ?? "not set";
          const stderr = [
            `Executable=${join(path, "Contents", "MacOS", meta.plist.CFBundleExecutable ?? "ChatGPT")}`,
            `Identifier=${meta.plist.CFBundleIdentifier ?? ""}`,
            `TeamIdentifier=${team}`,
            `Authority=Developer ID Application: OpenAI OpCo, LLC (${team})`,
          ].join("\n");
          return { stdout: "", stderr, exitCode: 0 };
        }
      }
      return { stdout: "", stderr: "code object is not signed at all", exitCode: 1 };
    }

    return { stdout: "", stderr: `unexpected command: ${file}`, exitCode: 127 };
  }
}

export function createMemoryHash(): HostHash {
  return {
    sha256Hex(data: Uint8Array) {
      return createHash("sha256").update(data).digest("hex");
    },
  };
}

export function createFixedClock(iso = "2026-07-23T12:00:00.000Z"): HostClock {
  return { nowIso: () => iso };
}

export function seedVirtualBundle(
  fs: MemoryFileSystem,
  options: VirtualHostBundleOptions = {},
): {
  bundlePath: string;
  executablePath: string;
  processMeta: {
    plist: Record<string, string>;
    signingTeam: string | null;
    codesignBroken?: boolean;
  };
  hostHashInputs: Record<string, Uint8Array>;
} {
  const opts = defaultCanonicalBundleOptions(options);
  const bundlePath = opts.bundlePath as string;
  const omit = new Set(opts.omit ?? []);

  fs.seedDir(bundlePath);

  if (!omit.has("contents")) {
    fs.seedDir(join(bundlePath, "Contents"));
  }
  if (!omit.has("macos") && !omit.has("contents")) {
    fs.seedDir(join(bundlePath, "Contents", "MacOS"));
  }

  const plistText =
    opts.infoPlistContent !== undefined
      ? typeof opts.infoPlistContent === "string"
        ? opts.infoPlistContent
        : new TextDecoder().decode(opts.infoPlistContent)
      : buildInfoPlist({
          bundleId: opts.bundleId as string,
          executableName: opts.executableName as string,
          appVersion: opts.appVersion as string,
          appBuild: opts.appBuild as string,
        });

  if (!omit.has("infoPlist") && !omit.has("contents")) {
    fs.seedFile(join(bundlePath, "Contents", "Info.plist"), plistText);
  }

  const executablePath =
    opts.executableAbsolutePath ??
    join(bundlePath, "Contents", "MacOS", opts.executableName as string);

  const execBytes =
    opts.executableContent !== undefined
      ? typeof opts.executableContent === "string"
        ? enc(opts.executableContent)
        : opts.executableContent
      : enc(`mach-o-stub:${opts.appBuild}`);

  if (!omit.has("executable") && !omit.has("macos") && !omit.has("contents")) {
    // Ensure parent exists when executable is relocated.
    fs.seedFile(executablePath, execBytes, 0o755);
  }

  if (opts.extraFiles) {
    for (const [rel, content] of Object.entries(opts.extraFiles)) {
      fs.seedFile(join(bundlePath, rel), content);
    }
  }

  if (opts.realpathMap) {
    for (const [from, to] of Object.entries(opts.realpathMap)) {
      fs.setRealpath(from, to);
    }
  } else {
    fs.setRealpath(bundlePath, bundlePath);
    if (!omit.has("executable")) {
      fs.setRealpath(join(bundlePath, "Contents", "MacOS", opts.executableName as string), executablePath);
    }
  }

  const hostHashInputs: Record<string, Uint8Array> = {};
  for (const rel of COMPATIBILITY_HOST_HASH_RELATIVE_PATHS) {
    const abs = join(bundlePath, rel);
    // Prefer seeded content when present.
    const entry = fs.entries.get(norm(abs));
    if (entry && entry.kind === "file") {
      hostHashInputs[rel] = entry.content;
    }
  }

  return {
    bundlePath,
    executablePath,
    processMeta: {
      plist: {
        CFBundleIdentifier: opts.bundleId as string,
        CFBundleExecutable: opts.executableName as string,
        CFBundleShortVersionString: opts.appVersion as string,
        CFBundleVersion: opts.appBuild as string,
      },
      signingTeam: opts.codesignBroken ? null : ((opts.signingTeam as string) ?? null),
      codesignBroken: opts.codesignBroken,
    },
    hostHashInputs,
  };
}

export function createFixtureAdapters(options: {
  bundles?: VirtualHostBundleOptions[];
  clockIso?: string;
}): {
  adapters: HostAdapters;
  fs: MemoryFileSystem;
  bundles: ReturnType<typeof seedVirtualBundle>[];
} {
  const fs = new MemoryFileSystem();
  const seeded: ReturnType<typeof seedVirtualBundle>[] = [];
  const processBundles = new Map<
    string,
    {
      plist: Record<string, string>;
      signingTeam: string | null;
      codesignBroken?: boolean;
    }
  >();

  for (const bundleOpts of options.bundles ?? [defaultCanonicalBundleOptions()]) {
    const seededBundle = seedVirtualBundle(fs, bundleOpts);
    seeded.push(seededBundle);
    processBundles.set(seededBundle.bundlePath, seededBundle.processMeta);
  }

  const adapters: HostAdapters = {
    fs,
    process: new VirtualProcess({ bundles: processBundles }),
    clock: createFixedClock(options.clockIso),
    hash: createMemoryHash(),
  };

  return { adapters, fs, bundles: seeded };
}

export function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
