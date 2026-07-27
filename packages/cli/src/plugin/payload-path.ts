import { posix } from "node:path";
import { ARTIFACT_SCHEMA_V1_LIMITS } from "./artifact-schema.ts";

export type PayloadPathKind = "file" | "directory";

export type ValidatedPayloadPath = {
  path: string;
  collisionKey: string;
  components: readonly string[];
  utf8Bytes: number;
};

export type PayloadPathFailure = {
  ok: false;
  entryClass: string;
  message: string;
  path: string;
};

export type PayloadPathResult =
  | { ok: true; validated: ValidatedPayloadPath }
  | PayloadPathFailure;

const DRIVE_LIKE = /^[A-Za-z]:/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function failure(
  path: string,
  entryClass: string,
  message: string,
): PayloadPathFailure {
  return { ok: false, path, entryClass, message };
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) return false;
  }
  return true;
}

function collisionComponent(component: string): string {
  return component.toLocaleLowerCase("en-US").normalize("NFC");
}

/**
 * Validate one canonical installable payload path without lossy normalization.
 * NFC and case folding are used only to detect aliases between distinct paths.
 */
export function validateNormalizedPayloadPath(
  rawPath: string,
  options?: {
    kind?: PayloadPathKind;
    maxUtf8Bytes?: number | null;
  },
): PayloadPathResult {
  const kind = options?.kind ?? "file";
  if (rawPath.length === 0) {
    return failure(rawPath, "empty-path", "Payload path must not be empty.");
  }
  if (!hasWellFormedUnicode(rawPath)) {
    return failure(
      rawPath,
      "invalid-unicode",
      `Payload path contains an unpaired surrogate: ${JSON.stringify(rawPath)}`,
    );
  }
  if (rawPath.startsWith("/")) {
    return failure(rawPath, "absolute-path", `Payload path is absolute: ${rawPath}`);
  }
  if (DRIVE_LIKE.test(rawPath)) {
    return failure(rawPath, "drive-like-path", `Payload path is drive-like: ${rawPath}`);
  }
  if (rawPath.includes("\\")) {
    return failure(rawPath, "backslash", `Payload path contains a backslash: ${rawPath}`);
  }
  if (CONTROL.test(rawPath)) {
    return failure(
      rawPath,
      "control-character",
      `Payload path contains a control character: ${JSON.stringify(rawPath)}`,
    );
  }
  if (kind === "file" && rawPath.endsWith("/")) {
    return failure(rawPath, "directory-suffix", `Payload file path ends with a slash: ${rawPath}`);
  }

  const withoutDirectorySuffix = kind === "directory" && rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
  if (withoutDirectorySuffix.length === 0) {
    return failure(rawPath, "empty-path", "Payload path resolves to an empty path.");
  }
  const components = withoutDirectorySuffix.split("/");
  if (components.some((component) => component.length === 0)) {
    return failure(
      rawPath,
      "empty-component",
      `Payload path contains an empty component: ${rawPath}`,
    );
  }
  if (components.includes("..")) {
    return failure(rawPath, "traversal", `Payload path contains traversal: ${rawPath}`);
  }
  if (components.includes(".")) {
    return failure(rawPath, "dot-component", `Payload path contains a dot component: ${rawPath}`);
  }
  if (components.some((component) => component.normalize("NFC") !== component)) {
    return failure(
      rawPath,
      "non-canonical-unicode",
      `Payload path is not NFC-normalized: ${rawPath}`,
    );
  }

  const normalized = components.join("/");
  if (posix.normalize(normalized) !== normalized) {
    return failure(
      rawPath,
      "non-canonical-path",
      `Payload path is not canonical: ${rawPath}`,
    );
  }
  const utf8Bytes = Buffer.byteLength(normalized, "utf8");
  const maximum = options?.maxUtf8Bytes === undefined
    ? ARTIFACT_SCHEMA_V1_LIMITS.maxNormalizedPathBytes
    : options.maxUtf8Bytes;
  if (maximum !== null && utf8Bytes > maximum) {
    return failure(
      rawPath,
      "normalized-path-bytes",
      `Payload path is ${utf8Bytes} UTF-8 bytes; maximum is ${maximum}.`,
    );
  }

  return {
    ok: true,
    validated: {
      path: normalized,
      components,
      utf8Bytes,
      collisionKey: components
        .map(collisionComponent)
        .join("/"),
    },
  };
}

export function comparePayloadPathsByUtf8Bytes(
  left: string,
  right: string,
): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export class PayloadPathTopologyTracker {
  readonly #byPath = new Map<string, PayloadPathKind>();
  readonly #byCollisionKey = new Map<
    string,
    { path: string; kind: PayloadPathKind }
  >();

  add(
    path: ValidatedPayloadPath,
    kind: PayloadPathKind,
  ): PayloadPathFailure | null {
    if (this.#byPath.has(path.path)) {
      return failure(path.path, "duplicate-path", `Payload contains duplicate path: ${path.path}`);
    }
    const collided = this.#byCollisionKey.get(path.collisionKey);
    if (collided !== undefined && collided.path !== path.path) {
      return failure(
        path.path,
        "normalized-collision",
        `Payload paths collide after Unicode/case normalization: ${collided.path} and ${path.path}`,
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
          `Payload path ${path.path} descends through normalized file ${ancestor.path}.`,
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
            `Payload file ${path.path} conflicts with normalized descendant ${existing.path}.`,
          );
        }
      }
    }

    this.#byPath.set(path.path, kind);
    this.#byCollisionKey.set(path.collisionKey, { path: path.path, kind });
    return null;
  }

  addFileWithImplicitDirectories(
    path: ValidatedPayloadPath,
  ): PayloadPathFailure | null {
    for (let index = 1; index < path.components.length; index += 1) {
      const components = path.components.slice(0, index);
      const directoryPath = components.join("/");
      const existingKind = this.#byPath.get(directoryPath);
      if (existingKind === "directory") continue;
      if (existingKind === "file") {
        return failure(
          path.path,
          "file-directory-topology",
          `Payload path ${path.path} descends through file ${directoryPath}.`,
        );
      }
      const directory: ValidatedPayloadPath = {
        path: directoryPath,
        components,
        utf8Bytes: Buffer.byteLength(directoryPath, "utf8"),
        collisionKey: components
          .map(collisionComponent)
          .join("/"),
      };
      const directoryFailure = this.add(directory, "directory");
      if (directoryFailure !== null) return directoryFailure;
    }
    return this.add(path, "file");
  }
}
