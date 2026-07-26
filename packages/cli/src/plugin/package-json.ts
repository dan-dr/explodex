/**
 * Parse and validate package.json fields relevant to plugin source identity.
 * package.json.version is package-manager metadata only and is never artifact identity.
 */

export type ParsedPluginPackageJson = {
  name: string;
  /** Package-manager metadata only; never used as artifact version. */
  packageManagerVersion: string;
  sdkRange: string;
  private?: boolean;
  type?: string;
};

export type PackageJsonParseResult =
  | { ok: true; value: ParsedPluginPackageJson }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

const LOCAL_OR_WORKSPACE_RANGE =
  /^(?:file:|link:|portal:|workspace:|github:|git\+|git:|http:|https:|npm:)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePluginPackageJson(raw: unknown): PackageJsonParseResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "package.json must be a JSON object.",
    };
  }

  if (typeof raw.name !== "string" || raw.name.length === 0) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "package.json name must be a non-empty string.",
      details: { name: raw.name },
    };
  }

  const packageManagerVersion =
    typeof raw.version === "string" && raw.version.length > 0 ? raw.version : "0.0.0";

  const peers = raw.peerDependencies;
  if (!isRecord(peers)) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: 'package.json peerDependencies["@explodex/sdk"] is required.',
    };
  }

  const sdkRange = peers["@explodex/sdk"];
  if (sdkRange === undefined) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: 'package.json peerDependencies["@explodex/sdk"] is required.',
    };
  }
  if (typeof sdkRange !== "string") {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: 'peerDependencies["@explodex/sdk"] must be a string range.',
      details: { sdkRange },
    };
  }
  if (sdkRange.trim().length === 0) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: 'peerDependencies["@explodex/sdk"] must not be empty.',
    };
  }
  if (LOCAL_OR_WORKSPACE_RANGE.test(sdkRange.trim())) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message:
        'peerDependencies["@explodex/sdk"] must be a publishable range, not a local, workspace, or URL reference.',
      details: { sdkRange },
    };
  }
  if (!isPlausibleSemverRange(sdkRange)) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: 'peerDependencies["@explodex/sdk"] is not a valid SemVer range.',
      details: { sdkRange },
    };
  }

  const result: ParsedPluginPackageJson = {
    name: raw.name,
    packageManagerVersion,
    sdkRange,
  };
  if (typeof raw.private === "boolean") result.private = raw.private;
  if (typeof raw.type === "string") result.type = raw.type;
  return { ok: true, value: result };
}

/**
 * Lightweight range grammar check shared with source validation.
 * Full satisfaction checks use @explodex/sdk range authority when needed.
 */
function isPlausibleSemverRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  // Reject path-like and absolute forms not already caught.
  if (trimmed.includes("\\") || trimmed.includes("..")) return false;
  // Accept common npm range forms: exact, caret, tilde, comparators, unions, wildcards.
  const token =
    /^(?:(?:\^|~|>=|<=|>|<|=)?\s*(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*|x|X|\*)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|\*|x|X)$/;
  const parts = trimmed.split(/\s*\|\|\s*/);
  if (parts.length === 0) return false;
  for (const part of parts) {
    const conjuncts = part.trim().split(/\s+/).filter((item) => item.length > 0);
    if (conjuncts.length === 0) return false;
    for (const conjunct of conjuncts) {
      if (!token.test(conjunct)) return false;
    }
  }
  return true;
}
