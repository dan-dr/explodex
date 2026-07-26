/**
 * Opaque artifact version validation and path-component encoding.
 * Artifact version is config authority; package.json.version is never substituted.
 */

const MAX_VERSION_LENGTH = 128;
const MAX_ENCODED_LENGTH = 200;

export type OpaqueVersionResult =
  | { ok: true; version: string; encoded: string }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/**
 * Validate an opaque artifact version and prove it round-trips through the
 * path-safe encoder used for archive names and install paths.
 */
export function validateOpaqueVersion(value: unknown): OpaqueVersionResult {
  if (typeof value !== "string") {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must be a string.",
      details: { version: value },
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must not be empty.",
    };
  }
  if (value.trim().length === 0) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must not be whitespace-only.",
    };
  }
  if (value !== value.trim()) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must not have leading or trailing whitespace.",
      details: { version: value },
    };
  }
  if (value.length > MAX_VERSION_LENGTH) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: `Artifact version must be at most ${MAX_VERSION_LENGTH} characters.`,
      details: { length: value.length },
    };
  }

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: "Artifact version must not contain control characters.",
        details: { index: i },
      };
    }
  }

  if (value.includes("/") || value.includes("\\")) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must not contain path separators.",
      details: { version: value },
    };
  }
  if (value.includes("..")) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must not contain path traversal sequences.",
      details: { version: value },
    };
  }
  if (value.startsWith("~") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must not look like an absolute or home path.",
      details: { version: value },
    };
  }

  let encoded: string;
  try {
    encoded = encodeOpaqueVersionComponent(value);
  } catch (error: unknown) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: error instanceof Error ? error.message : "Artifact version encoding failed.",
      details: { version: value },
    };
  }

  if (encoded.length > MAX_ENCODED_LENGTH) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Encoded artifact version exceeds the path length bound.",
      details: { encodedLength: encoded.length },
    };
  }

  const decoded = decodeOpaqueVersionComponent(encoded);
  if (decoded !== value) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version does not round-trip through path encoding.",
      details: { version: value, encoded, decoded },
    };
  }

  // NFC normalization must be identity: reject values that change under NFC.
  const normalized = value.normalize("NFC");
  if (normalized !== value) {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: "Artifact version must already be Unicode NFC-normalized.",
      details: { version: value },
    };
  }

  return { ok: true, version: value, encoded };
}

/**
 * Case-stable, length-bounded percent-encoding for opaque version path components.
 * Unreserved: A-Z a-z 0-9 . _ - +
 */
export function encodeOpaqueVersionComponent(version: string): string {
  let out = "";
  for (const char of version) {
    if (/[A-Za-z0-9._+-]/.test(char)) {
      out += char;
      continue;
    }
    const bytes = Buffer.from(char, "utf8");
    for (const byte of bytes) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  if (out.length === 0) {
    throw new Error("Encoded artifact version must not be empty.");
  }
  return out;
}

export function decodeOpaqueVersionComponent(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error("Encoded artifact version is not valid percent-encoding.");
  }
}
