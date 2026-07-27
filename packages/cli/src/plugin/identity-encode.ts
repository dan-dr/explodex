/**
 * Canonical identity encoding for archive roots, release asset names, and
 * installed directory components. Case-stable, length-bounded, UTF-8 percent
 * encoding with an explicit payloadSha256 suffix.
 */

import { encodeOpaqueVersionComponent } from "./version.ts";

/** Ustar name-field byte limit for the single-component archive root. */
export const MAX_ARCHIVE_ROOT_NAME_LENGTH = 100;

/** Maximum length of a release/archive file basename. */
export const MAX_ARCHIVE_FILE_NAME_LENGTH = 255;
export const MAX_INSTALLED_DIRECTORY_NAME_LENGTH = 255;

const PAYLOAD_HEX_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type EncodedArtifactIdentity = {
  /** Exact plugin ID (unencoded; already path-safe by contract). */
  id: string;
  /** Exact opaque version. */
  version: string;
  /** Full lowercase payload digest. */
  payloadSha256: string;
  /** Encoded opaque version component. */
  encodedVersion: string;
  /**
   * Single named top-level archive directory:
   * `{id}-{encodedVersion}-{payloadSha256}`
   */
  archiveRootName: string;
  /** Canonical archive basename: `{archiveRootName}.tar.gz` */
  archiveFileName: string;
  /**
   * Installed directory name under `~/.explodex/plugins/<id>/`:
   * `{encodedVersion}-{payloadSha256}`
   */
  installedDirectoryName: string;
};

/**
 * Percent-encode a path component with the same rules as opaque version
 * encoding: unreserved A-Z a-z 0-9 . _ - +; other UTF-8 bytes as %HH (upper).
 */
export function encodeIdentityComponent(value: string): string {
  let out = "";
  for (const char of value) {
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
    throw new Error("Encoded identity component must not be empty.");
  }
  return out;
}

/**
 * Build the canonical encoded identity used for archive topology and paths.
 * Never substitutes archiveSha256 for the payload digest suffix.
 */
export function encodeArtifactIdentity(options: {
  id: string;
  version: string;
  payloadSha256: string;
}): EncodedArtifactIdentity {
  const { id, version, payloadSha256 } = options;
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      "Plugin id must be lowercase alphanumerics with single hyphen separators.",
    );
  }
  if (!PAYLOAD_HEX_PATTERN.test(payloadSha256)) {
    throw new Error("payloadSha256 must be 64 lowercase hexadecimal characters.");
  }

  const encodedVersion = encodeOpaqueVersionComponent(version);
  // ID is already path-safe; still run through the encoder for one vocabulary.
  const encodedId = encodeIdentityComponent(id);
  const archiveRootName = `${encodedId}-${encodedVersion}-${payloadSha256}`;
  if (Buffer.byteLength(archiveRootName, "utf8") > MAX_ARCHIVE_ROOT_NAME_LENGTH) {
    throw new Error(
      `Encoded archive root name exceeds ${MAX_ARCHIVE_ROOT_NAME_LENGTH} UTF-8 bytes.`,
    );
  }
  const archiveFileName = `${archiveRootName}.tar.gz`;
  if (Buffer.byteLength(archiveFileName, "utf8") > MAX_ARCHIVE_FILE_NAME_LENGTH) {
    throw new Error(
      `Encoded archive file name exceeds ${MAX_ARCHIVE_FILE_NAME_LENGTH} UTF-8 bytes.`,
    );
  }
  const installedDirectoryName = `${encodedVersion}-${payloadSha256}`;
  if (
    Buffer.byteLength(installedDirectoryName, "utf8") >
      MAX_INSTALLED_DIRECTORY_NAME_LENGTH
  ) {
    throw new Error(
      `Encoded installed directory name exceeds ${MAX_INSTALLED_DIRECTORY_NAME_LENGTH} UTF-8 bytes.`,
    );
  }

  return {
    id,
    version,
    payloadSha256,
    encodedVersion,
    archiveRootName,
    archiveFileName,
    installedDirectoryName,
  };
}
