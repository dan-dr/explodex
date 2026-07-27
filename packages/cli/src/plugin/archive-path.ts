import { posix } from "node:path";
import { ARTIFACT_SCHEMA_V1_LIMITS } from "./artifact-schema.ts";

export type ArchiveEntryKind = "file" | "directory";

export type ValidatedArchivePath = {
  path: string;
  collisionKey: string;
  components: readonly string[];
  utf8Bytes: number;
};

export type ArchivePathFailure = {
  ok: false;
  entryClass: string;
  message: string;
  path: string;
};

export type ArchivePathResult =
  | { ok: true; validated: ValidatedArchivePath }
  | ArchivePathFailure;

const DRIVE_LIKE = /^[A-Za-z]:/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function failure(path: string, entryClass: string, message: string): ArchivePathFailure {
  return { ok: false, path, entryClass, message };
}

/**
 * Validate one raw POSIX archive path without lossy normalization.
 * Unicode NFC and case folding are used only for collision detection.
 */
export function validateArchivePath(
  rawPath: string,
  options?: { maxUtf8Bytes?: number | null },
): ArchivePathResult {
  if (rawPath.length === 0) {
    return failure(rawPath, "empty-path", "Archive entry path must not be empty.");
  }
  if (rawPath.startsWith("/")) {
    return failure(rawPath, "absolute-path", `Archive entry path is absolute: ${rawPath}`);
  }
  if (DRIVE_LIKE.test(rawPath)) {
    return failure(rawPath, "drive-like-path", `Archive entry path is drive-like: ${rawPath}`);
  }
  if (rawPath.includes("\\")) {
    return failure(rawPath, "backslash", `Archive entry path contains a backslash: ${rawPath}`);
  }
  if (CONTROL.test(rawPath)) {
    return failure(rawPath, "control-character", `Archive entry path contains a control character: ${JSON.stringify(rawPath)}`);
  }

  const withoutDirectorySuffix = rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
  if (withoutDirectorySuffix.length === 0) {
    return failure(rawPath, "empty-path", "Archive entry path resolves to an empty path.");
  }
  const components = withoutDirectorySuffix.split("/");
  if (components.some((component) => component.length === 0)) {
    return failure(rawPath, "empty-component", `Archive entry path contains an empty component: ${rawPath}`);
  }
  if (components.includes("..")) {
    return failure(rawPath, "traversal", `Archive entry path contains traversal: ${rawPath}`);
  }
  if (components.includes(".")) {
    return failure(rawPath, "dot-component", `Archive entry path contains a dot component: ${rawPath}`);
  }

  const normalized = components.join("/");
  if (posix.normalize(normalized) !== normalized) {
    return failure(rawPath, "non-canonical-path", `Archive entry path is not canonical: ${rawPath}`);
  }
  const utf8Bytes = Buffer.byteLength(normalized, "utf8");
  const maximum = options?.maxUtf8Bytes === undefined
    ? ARTIFACT_SCHEMA_V1_LIMITS.maxNormalizedPathBytes
    : options.maxUtf8Bytes;
  if (maximum !== null && utf8Bytes > maximum) {
    return failure(
      rawPath,
      "normalized-path-bytes",
      `Archive path is ${utf8Bytes} UTF-8 bytes; maximum is ${maximum}.`,
    );
  }

  return {
    ok: true,
    validated: {
      path: normalized,
      components,
      utf8Bytes,
      collisionKey: components
        .map((component) => component.normalize("NFC").toLocaleLowerCase("en-US"))
        .join("/"),
    },
  };
}

export class ArchiveTopologyTracker {
  readonly #byPath = new Map<string, ArchiveEntryKind>();
  readonly #byCollisionKey = new Map<
    string,
    { path: string; kind: ArchiveEntryKind }
  >();

  add(path: ValidatedArchivePath, kind: ArchiveEntryKind): ArchivePathFailure | null {
    if (this.#byPath.has(path.path)) {
      return failure(path.path, "duplicate-path", `Archive contains duplicate path: ${path.path}`);
    }
    const collided = this.#byCollisionKey.get(path.collisionKey);
    if (collided !== undefined && collided.path !== path.path) {
      return failure(
        path.path,
        "normalized-collision",
        `Archive paths collide after Unicode/case normalization: ${collided.path} and ${path.path}`,
      );
    }

    const normalizedComponents = path.collisionKey.split("/");
    for (let index = 1; index < normalizedComponents.length; index += 1) {
      const ancestorKey = normalizedComponents.slice(0, index).join("/");
      const ancestor = this.#byCollisionKey.get(ancestorKey);
      if (ancestor?.kind === "file") {
        return failure(
          path.path,
          "file-directory-topology",
          `Archive path ${path.path} descends through normalized file ${ancestor.path}.`,
        );
      }
    }
    if (kind === "file") {
      const prefix = `${path.collisionKey}/`;
      for (const [existingKey, existing] of this.#byCollisionKey) {
        if (existingKey.startsWith(prefix)) {
          return failure(
            path.path,
            "file-directory-topology",
            `Archive file ${path.path} conflicts with normalized descendant ${existing.path}.`,
          );
        }
      }
    }

    this.#byPath.set(path.path, kind);
    this.#byCollisionKey.set(path.collisionKey, { path: path.path, kind });
    return null;
  }
}
