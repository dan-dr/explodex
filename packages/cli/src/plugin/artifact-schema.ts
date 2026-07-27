/**
 * Public immutable V1 archive expansion limits.
 *
 * These values are part of the artifact schema. Every archive consumer uses
 * this exact set, independent of source, host memory, disk space, or locale.
 */
export const ARTIFACT_SCHEMA_V1_LIMITS = Object.freeze({
  schemaVersion: 1 as const,
  maxArchiveEntries: 256,
  maxNormalizedPathBytes: 100,
  maxFileUncompressedBytes: 16 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
});

export type ArtifactSchemaV1LimitName =
  | "archive-entries"
  | "normalized-path-bytes"
  | "file-uncompressed-bytes"
  | "total-uncompressed-bytes"
  | "compression-ratio";

export type ArchiveExpansionMetrics = {
  entryCount: number;
  normalizedPathBytes: number;
  fileUncompressedBytes: number;
  totalUncompressedBytes: number;
  archiveBytes: number;
  /** Used only while incrementally validating metrics before decompression is complete. */
  skipCompressionRatio?: boolean;
};

export type ArchiveExpansionResult =
  | { ok: true }
  | {
      ok: false;
      limit: ArtifactSchemaV1LimitName;
      maximum: number;
      actual: number;
      message: string;
    };

/** Validate metrics against the public schema constants. Exact boundaries pass. */
export function validateArchiveExpansionMetrics(
  metrics: ArchiveExpansionMetrics,
): ArchiveExpansionResult {
  const limits = ARTIFACT_SCHEMA_V1_LIMITS;
  if (metrics.entryCount > limits.maxArchiveEntries) {
    return {
      ok: false,
      limit: "archive-entries",
      maximum: limits.maxArchiveEntries,
      actual: metrics.entryCount,
      message: `Archive contains ${metrics.entryCount} entries; maximum is ${limits.maxArchiveEntries}.`,
    };
  }
  if (metrics.normalizedPathBytes > limits.maxNormalizedPathBytes) {
    return {
      ok: false,
      limit: "normalized-path-bytes",
      maximum: limits.maxNormalizedPathBytes,
      actual: metrics.normalizedPathBytes,
      message: `Archive path is ${metrics.normalizedPathBytes} UTF-8 bytes; maximum is ${limits.maxNormalizedPathBytes}.`,
    };
  }
  if (metrics.fileUncompressedBytes > limits.maxFileUncompressedBytes) {
    return {
      ok: false,
      limit: "file-uncompressed-bytes",
      maximum: limits.maxFileUncompressedBytes,
      actual: metrics.fileUncompressedBytes,
      message: `Archive file expands to ${metrics.fileUncompressedBytes} bytes; maximum is ${limits.maxFileUncompressedBytes}.`,
    };
  }
  if (metrics.totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
    return {
      ok: false,
      limit: "total-uncompressed-bytes",
      maximum: limits.maxTotalUncompressedBytes,
      actual: metrics.totalUncompressedBytes,
      message: `Archive expands to ${metrics.totalUncompressedBytes} file bytes; maximum is ${limits.maxTotalUncompressedBytes}.`,
    };
  }
  if (!metrics.skipCompressionRatio && metrics.totalUncompressedBytes > 0) {
    const ratio = metrics.totalUncompressedBytes / Math.max(1, metrics.archiveBytes);
    if (ratio > limits.maxCompressionRatio) {
      return {
        ok: false,
        limit: "compression-ratio",
        maximum: limits.maxCompressionRatio,
        actual: ratio,
        message: `Archive compression ratio ${ratio.toFixed(2)} exceeds maximum ${limits.maxCompressionRatio}.`,
      };
    }
  }
  return { ok: true };
}
