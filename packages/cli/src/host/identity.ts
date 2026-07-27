import { basename, join, sep } from "node:path";
import type { HostAdapters } from "./adapters.ts";
import {
  CANONICAL_BUNDLE_ID,
  CANONICAL_BUNDLE_PATH,
  CANONICAL_EXECUTABLE_NAME,
  CANONICAL_SIGNING_TEAM,
  COMPATIBILITY_HOST_HASH_RELATIVE_PATHS,
} from "./constants.ts";
import type {
  HostCandidateSummary,
  HostFailureCode,
  HostIdentity,
  HostInspectionResult,
} from "./types.ts";

/**
 * Production host inspection options. Only the canonical installed path is
 * inspected. There is intentionally no path override, authority token, or
 * alternate-bundle helper in this public module or package export surface.
 * Controlled fixtures must seed or map content at `/Applications/ChatGPT.app`
 * through injectable adapters.
 */
export type InspectHostOptions = {
  adapters: HostAdapters;
  signal?: AbortSignal;
};

type PlistFields = {
  bundleId: string | null;
  executableName: string | null;
  appVersion: string | null;
  appBuild: string | null;
};

const CHATGPT_SIGNATURE_REQUIREMENT =
  'identifier "com.openai.codex" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "2DC432GLL2"';

function candidate(
  path: string,
  reason: string,
  extra: Partial<HostCandidateSummary> = {},
): HostCandidateSummary {
  return { path, reason, ...extra };
}

function fail(
  code: HostFailureCode,
  message: string,
  failedPredicates: string[],
  candidates: HostCandidateSummary[] = [],
): HostInspectionResult {
  return {
    ok: false,
    hostValid: false,
    host: null,
    selected: false,
    readOnly: true,
    compatibility: {
      status: "unproven",
      key: null,
      currentKey: null,
      matched: false,
      reason: "host_invalid",
      nextAction: null,
      allowsCompatibilityDependentWork: false,
    },
    error: { code, message, failedPredicates, candidates },
  };
}

async function readPlistFields(
  adapters: HostAdapters,
  infoPlistPath: string,
): Promise<PlistFields> {
  const fields: PlistFields = {
    bundleId: null,
    executableName: null,
    appVersion: null,
    appBuild: null,
  };

  const keys: Array<{ key: keyof PlistFields; plistKey: string }> = [
    { key: "bundleId", plistKey: "CFBundleIdentifier" },
    { key: "executableName", plistKey: "CFBundleExecutable" },
    { key: "appVersion", plistKey: "CFBundleShortVersionString" },
    { key: "appBuild", plistKey: "CFBundleVersion" },
  ];

  for (const { key, plistKey } of keys) {
    const result = await adapters.process.execFile("/usr/bin/plutil", [
      "-extract",
      plistKey,
      "raw",
      "-o",
      "-",
      infoPlistPath,
    ]);
    if (result.exitCode === 0) {
      const value = result.stdout.trim();
      fields[key] = value.length > 0 ? value : null;
    }
  }

  return fields;
}

async function readSigningIdentity(
  adapters: HostAdapters,
  bundlePath: string,
): Promise<{ valid: boolean; team: string | null }> {
  const verification = await adapters.process.execFile("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    `-R=${CHATGPT_SIGNATURE_REQUIREMENT}`,
    bundlePath,
  ]);
  if (verification.exitCode !== 0) {
    return { valid: false, team: null };
  }

  const details = await adapters.process.execFile("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    bundlePath,
  ]);
  if (details.exitCode !== 0) {
    return { valid: false, team: null };
  }

  // codesign writes identity details to stderr.
  const raw = `${details.stderr}\n${details.stdout}`;
  const teamMatch = raw.match(/^\s*TeamIdentifier\s*=\s*(.+)\s*$/m);
  const team = teamMatch?.[1]?.trim() ?? null;
  if (team === null || team === "" || team === "not set") {
    return { valid: true, team: null };
  }
  return { valid: true, team };
}

function isInsideBundle(bundlePath: string, absolutePath: string): boolean {
  const normalizedBundle = bundlePath.endsWith(sep) ? bundlePath.slice(0, -1) : bundlePath;
  return absolutePath === normalizedBundle || absolutePath.startsWith(`${normalizedBundle}${sep}`);
}

/**
 * Resolve and validate the canonical ChatGPT.app host read-only.
 * Never selects Codex.app, vendor copies, wrappers, or alternate bundles.
 * Public production APIs cannot select any path except the canonical install.
 */
export async function inspectHost(options: InspectHostOptions): Promise<HostInspectionResult> {
  const adapters = options.adapters;
  const requestedPath = CANONICAL_BUNDLE_PATH;
  const failed: string[] = [];
  const candidates: HostCandidateSummary[] = [];

  const exists = await adapters.fs.exists(requestedPath);
  if (!exists) {
    return fail(
      "host_missing",
      `Canonical host is missing at ${requestedPath}`,
      ["bundle_exists"],
      [candidate(requestedPath, "missing")],
    );
  }

  let realBundlePath: string;
  try {
    realBundlePath = await adapters.fs.realpath(requestedPath);
  } catch {
    return fail(
      "host_malformed",
      `Unable to resolve real path for ${requestedPath}`,
      ["bundle_realpath"],
      [candidate(requestedPath, "realpath_failed")],
    );
  }

  if (realBundlePath !== CANONICAL_BUNDLE_PATH) {
    candidates.push(
      candidate(realBundlePath, "not_canonical_path", {
        reason: `resolved path ${realBundlePath} is not ${CANONICAL_BUNDLE_PATH}`,
      }),
    );
    return fail(
      "host_not_canonical_path",
      `Host must resolve exactly to ${CANONICAL_BUNDLE_PATH}; got ${realBundlePath}`,
      ["canonical_path"],
      candidates,
    );
  }

  // Reject known non-product names even if a fixture somehow shadows the path.
  const base = basename(realBundlePath);
  if (base !== "ChatGPT.app") {
    return fail(
      "host_wrong_identity",
      `Refusing non-canonical host bundle name ${base}`,
      ["bundle_name"],
      [candidate(realBundlePath, "wrong_bundle_name")],
    );
  }

  const contentsDir = join(realBundlePath, "Contents");
  const infoPlistPath = join(contentsDir, "Info.plist");
  const macosDir = join(contentsDir, "MacOS");

  const contentsStat = await adapters.fs.stat(contentsDir);
  if (contentsStat.kind !== "directory") {
    failed.push("contents_directory");
  }
  const infoStat = await adapters.fs.stat(infoPlistPath);
  if (infoStat.kind !== "file") {
    failed.push("info_plist");
  }
  const macosStat = await adapters.fs.stat(macosDir);
  if (macosStat.kind !== "directory") {
    failed.push("macos_directory");
  }
  if (failed.length > 0) {
    return fail(
      "host_malformed",
      `Malformed app bundle structure at ${realBundlePath}`,
      failed,
      [candidate(realBundlePath, "malformed_structure")],
    );
  }

  const plist = await readPlistFields(adapters, infoPlistPath);
  if (plist.bundleId !== CANONICAL_BUNDLE_ID) {
    failed.push("cf_bundle_identifier");
  }
  if (plist.executableName !== CANONICAL_EXECUTABLE_NAME) {
    failed.push("cf_bundle_executable");
  }
  if (!plist.appVersion) {
    failed.push("cf_bundle_short_version_string");
  }
  if (!plist.appBuild) {
    failed.push("cf_bundle_version");
  }
  if (failed.length > 0) {
    return fail(
      "host_wrong_identity",
      `Host identity fields do not match the canonical ChatGPT.app product`,
      failed,
      [
        candidate(realBundlePath, "wrong_identity", {
          bundleId: plist.bundleId ?? undefined,
          executableName: plist.executableName ?? undefined,
        }),
      ],
    );
  }

  const declaredExecutablePath = join(macosDir, CANONICAL_EXECUTABLE_NAME);
  const execExists = await adapters.fs.exists(declaredExecutablePath);
  if (!execExists) {
    return fail(
      "host_broken_executable_relationship",
      `Missing inner executable at ${declaredExecutablePath}`,
      ["executable_exists"],
      [candidate(realBundlePath, "missing_executable", { executableName: CANONICAL_EXECUTABLE_NAME })],
    );
  }

  let realExecutablePath: string;
  try {
    realExecutablePath = await adapters.fs.realpath(declaredExecutablePath);
  } catch {
    return fail(
      "host_broken_executable_relationship",
      `Unable to resolve real path for executable ${declaredExecutablePath}`,
      ["executable_realpath"],
      [candidate(realBundlePath, "executable_realpath_failed")],
    );
  }

  if (!isInsideBundle(realBundlePath, realExecutablePath)) {
    return fail(
      "host_broken_executable_relationship",
      `Executable real path escapes the bundle: ${realExecutablePath}`,
      ["executable_inside_bundle"],
      [
        candidate(realBundlePath, "executable_outside_bundle", {
          executableName: basename(realExecutablePath),
        }),
      ],
    );
  }

  if (basename(realExecutablePath) !== CANONICAL_EXECUTABLE_NAME) {
    return fail(
      "host_broken_executable_relationship",
      `Executable basename must be ${CANONICAL_EXECUTABLE_NAME}; got ${basename(realExecutablePath)}`,
      ["executable_basename"],
      [
        candidate(realBundlePath, "wrong_executable_basename", {
          executableName: basename(realExecutablePath),
        }),
      ],
    );
  }

  const execStat = await adapters.fs.stat(realExecutablePath);
  if (execStat.kind !== "file") {
    return fail(
      "host_broken_executable_relationship",
      `Executable is not a regular file: ${realExecutablePath}`,
      ["executable_is_file"],
      [candidate(realBundlePath, "executable_not_file")],
    );
  }
  if (!(await adapters.fs.canExecute(realExecutablePath))) {
    return fail(
      "host_broken_executable_relationship",
      `Executable is not accessible for execution: ${realExecutablePath}`,
      ["executable_access"],
      [candidate(realBundlePath, "executable_not_executable")],
    );
  }

  const signing = await readSigningIdentity(adapters, realBundlePath);
  if (!signing.valid) {
    return fail(
      "host_invalid_signature",
      `Code signature verification failed for ${realBundlePath}`,
      ["signature_valid"],
      [candidate(realBundlePath, "signature_verification_failed")],
    );
  }
  if (signing.team !== CANONICAL_SIGNING_TEAM) {
    return fail(
      "host_invalid_signature",
      `Signing team must be ${CANONICAL_SIGNING_TEAM}; got ${signing.team ?? "unknown"}`,
      ["signing_team"],
      [
        candidate(realBundlePath, "invalid_signing_team", {
          signingTeam: signing.team ?? undefined,
        }),
      ],
    );
  }

  const hostHashes: Record<string, string> = {};
  for (const relative of COMPATIBILITY_HOST_HASH_RELATIVE_PATHS) {
    const absolute = join(realBundlePath, relative);
    try {
      const fileStat = await adapters.fs.stat(absolute);
      if (fileStat.kind !== "file") {
        throw new Error("not a regular file");
      }
      const bytes = await adapters.fs.readFile(absolute);
      hostHashes[relative] = adapters.hash.sha256Hex(bytes);
    } catch {
      return fail(
        "host_malformed",
        `Relevant host file is missing or unreadable: ${absolute}`,
        [`host_hash_readable:${relative}`],
        [candidate(realBundlePath, "host_hash_input_unreadable")],
      );
    }
  }

  const host: HostIdentity = {
    bundlePath: realBundlePath,
    executablePath: realExecutablePath,
    bundleId: CANONICAL_BUNDLE_ID,
    executableName: CANONICAL_EXECUTABLE_NAME,
    signingTeam: CANONICAL_SIGNING_TEAM,
    appVersion: plist.appVersion as string,
    appBuild: plist.appBuild as string,
    hostHashes,
  };

  return {
    ok: true,
    hostValid: true,
    host,
    selected: true,
    rejectedAlternates: [],
    readOnly: true,
    // Compatibility is filled by the caller that has home/SDK context.
    compatibility: {
      status: "unproven",
      key: null,
      currentKey: null,
      matched: false,
      reason: "compatibility_not_evaluated",
      nextAction: null,
      allowsCompatibilityDependentWork: false,
    },
  };
}

/** Convenience: inspect the production canonical host with default adapters. */
export async function inspectCanonicalHost(
  adapters: HostAdapters,
): Promise<HostInspectionResult> {
  return inspectHost({ adapters });
}
