/**
 * One public SDK version/range compatibility helper.
 * Shared by authoring, CLI validation, install, artifact validation, and runtime acceptance.
 * This module is the single authority; CLI and other packages must import it rather than
 * reimplementing SemVer range semantics.
 */

import { SDK_VERSION } from "./version.ts";

export type ParsedSemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
  build: string | undefined;
};

/**
 * Structured fail-closed verdict for version/range acceptance.
 * Used by CLI source validation, artifact validation, install, and runtime checks.
 */
export type SdkCompatibilityReason =
  | "version-missing"
  | "version-malformed"
  | "range-missing"
  | "range-malformed"
  | "out-of-range";

export type SdkCompatibilityVerdict =
  | {
      ok: true;
      version: string;
      range: string;
    }
  | {
      ok: false;
      reason: SdkCompatibilityReason;
      version: unknown;
      range: unknown;
    };

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse a strict SemVer string received from unknown external input.
 * Returns null for non-strings and malformed values.
 */
export function parseSemVer(value: unknown): ParsedSemVer | null {
  if (!isNonEmptyString(value)) return null;
  const trimmed = value.trim();
  const match = SEMVER_RE.exec(trimmed);
  if (match === null) return null;
  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) {
    return null;
  }
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  const prereleaseRaw = match[4];
  const build = match[5];
  const prerelease =
    prereleaseRaw === undefined || prereleaseRaw.length === 0
      ? []
      : prereleaseRaw.split(".").filter((part) => part.length > 0);
  if (prereleaseRaw !== undefined && prerelease.length === 0) return null;
  return { major, minor, patch, prerelease, build };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const diff = Number(a) - Number(b);
    return diff === 0 ? 0 : diff < 0 ? -1 : 1;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareSemVer(a: ParsedSemVer, b: ParsedSemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const cmp = compareIdentifiers(left, right);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

type Comparator = {
  op: ">" | ">=" | "<" | "<=" | "=";
  version: ParsedSemVer;
};

function parseComparator(token: string): Comparator | null {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token.trim());
  if (match === null) return null;
  const opRaw = match[1];
  const versionRaw = match[2];
  if (versionRaw === undefined) return null;
  const version = parseSemVer(versionRaw);
  if (version === null) return null;
  const op = (opRaw ?? "=") as Comparator["op"];
  return { op, version };
}

function satisfiesComparator(version: ParsedSemVer, comparator: Comparator): boolean {
  const cmp = compareSemVer(version, comparator.version);
  switch (comparator.op) {
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "=":
      return cmp === 0;
    default: {
      const _exhaustive: never = comparator.op;
      return _exhaustive;
    }
  }
}

function expandSimpleRange(token: string): Comparator[] | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("^")) {
    const base = parseSemVer(trimmed.slice(1));
    if (base === null) return null;
    if (base.major > 0) {
      return [
        { op: ">=", version: base },
        {
          op: "<",
          version: {
            major: base.major + 1,
            minor: 0,
            patch: 0,
            prerelease: [],
            build: undefined,
          },
        },
      ];
    }
    if (base.minor > 0) {
      return [
        { op: ">=", version: base },
        {
          op: "<",
          version: {
            major: 0,
            minor: base.minor + 1,
            patch: 0,
            prerelease: [],
            build: undefined,
          },
        },
      ];
    }
    return [
      { op: ">=", version: base },
      {
        op: "<",
        version: {
          major: 0,
          minor: 0,
          patch: base.patch + 1,
          prerelease: [],
          build: undefined,
        },
      },
    ];
  }

  if (trimmed.startsWith("~")) {
    const base = parseSemVer(trimmed.slice(1));
    if (base === null) return null;
    return [
      { op: ">=", version: base },
      {
        op: "<",
        version: {
          major: base.major,
          minor: base.minor + 1,
          patch: 0,
          prerelease: [],
          build: undefined,
        },
      },
    ];
  }

  const comparator = parseComparator(trimmed);
  if (comparator === null) return null;
  return [comparator];
}

function parseRangeSet(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const unionPart of range.split("||")) {
    const tokens = unionPart
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return null;
    const comparators: Comparator[] = [];
    for (const token of tokens) {
      const expanded = expandSimpleRange(token);
      if (expanded === null) return null;
      comparators.push(...expanded);
    }
    sets.push(comparators);
  }
  return sets.length === 0 ? null : sets;
}

function rangeAccepts(parsedVersion: ParsedSemVer, rangeText: string): boolean | null {
  const sets = parseRangeSet(rangeText);
  if (sets === null) return null;

  return sets.some((comparators) => {
    // Prerelease runtime versions only match when a comparator explicitly
    // includes a prerelease of the same major.minor.patch core.
    if (parsedVersion.prerelease.length > 0) {
      const allowsPrerelease = comparators.some(
        (comparator) =>
          comparator.version.prerelease.length > 0 &&
          comparator.version.major === parsedVersion.major &&
          comparator.version.minor === parsedVersion.minor &&
          comparator.version.patch === parsedVersion.patch,
      );
      if (!allowsPrerelease) return false;
    }
    return comparators.every((comparator) => satisfiesComparator(parsedVersion, comparator));
  });
}

/**
 * Return whether an exact SDK runtime version satisfies a peer range.
 * Both inputs are validated from unknown; malformed values fail closed.
 * Build metadata is parsed but ignored for comparison (SemVer §10).
 * Prerelease runtime versions only match when the comparator explicitly
 * includes a prerelease of the same major.minor.patch core.
 */
export function satisfiesSdkRange(version: unknown, range: unknown): boolean {
  const parsedVersion = parseSemVer(version);
  if (parsedVersion === null) return false;
  if (!isNonEmptyString(range)) return false;
  const accepted = rangeAccepts(parsedVersion, range.trim());
  return accepted === true;
}

/**
 * Structured compatibility check for unknown external inputs.
 * Distinguishes missing/malformed version, missing/malformed range, and out-of-range.
 * Never throws; always fails closed with an actionable reason code.
 */
export function evaluateSdkCompatibility(
  version: unknown,
  range: unknown,
): SdkCompatibilityVerdict {
  if (version === undefined || version === null || version === "") {
    return { ok: false, reason: "version-missing", version, range };
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    return { ok: false, reason: "version-malformed", version, range };
  }
  const parsedVersion = parseSemVer(version);
  if (parsedVersion === null) {
    return { ok: false, reason: "version-malformed", version, range };
  }

  if (range === undefined || range === null || range === "") {
    return { ok: false, reason: "range-missing", version, range };
  }
  if (typeof range !== "string" || range.trim().length === 0) {
    return { ok: false, reason: "range-malformed", version, range };
  }
  const accepted = rangeAccepts(parsedVersion, range.trim());
  if (accepted === null) {
    return { ok: false, reason: "range-malformed", version, range };
  }
  if (!accepted) {
    return { ok: false, reason: "out-of-range", version, range };
  }
  return { ok: true, version: version.trim(), range: range.trim() };
}

/** Convenience: does the authoritative runtime version satisfy this range? */
export function currentSdkSatisfiesRange(range: unknown): boolean {
  return satisfiesSdkRange(SDK_VERSION, range);
}
