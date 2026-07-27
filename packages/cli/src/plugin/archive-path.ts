import {
  PayloadPathTopologyTracker,
  validateNormalizedPayloadPath,
  type PayloadPathFailure,
  type PayloadPathResult,
  type ValidatedPayloadPath,
} from "./payload-path.ts";

export type ArchiveEntryKind = "file" | "directory";

export type ValidatedArchivePath = ValidatedPayloadPath;
export type ArchivePathFailure = PayloadPathFailure;
export type ArchivePathResult = PayloadPathResult;

/**
 * Validate one raw POSIX archive path without lossy normalization.
 * Unicode NFC and case folding are used only for collision detection.
 */
export function validateArchivePath(
  rawPath: string,
  options?: {
    kind?: ArchiveEntryKind;
    maxUtf8Bytes?: number | null;
  },
): ArchivePathResult {
  return validateNormalizedPayloadPath(rawPath, {
    kind: options?.kind ?? (rawPath.endsWith("/") ? "directory" : "file"),
    maxUtf8Bytes: options?.maxUtf8Bytes,
  });
}

export class ArchiveTopologyTracker extends PayloadPathTopologyTracker {}
