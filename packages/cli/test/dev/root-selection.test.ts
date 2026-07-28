import { describe, expect, test } from "bun:test";
import type { HostFileSystem } from "../../src/host/adapters.ts";
import {
  canonicalizeDevRootSelection,
  resolveDevRootSelection,
  validateDevRootSelection,
} from "../../src/dev/root-selection.ts";

function filesystem(): HostFileSystem {
  return {
    async exists() {
      return false;
    },
    async stat(path) {
      if (path === "/" || path === "/safe") return { kind: "directory" };
      if (path === "/safe/link") return { kind: "symlink" };
      if (path === "/target") return { kind: "directory" };
      return { kind: "missing" };
    },
    async canExecute() {
      return false;
    },
    async realpath(path) {
      if (path === "/safe/link") return "/target";
      return path;
    },
    async readFile() {
      return new Uint8Array();
    },
    async readDirectory() {
      return [];
    },
  };
}

describe("advanced development root ancestry", () => {
  test("rejects a user-controlled symlink ancestor after canonicalization", async () => {
    const fs = filesystem();
    const selection = resolveDevRootSelection({
      osHome: "/Users/author",
      explodexHome: "/Users/author/.explodex",
      explicitRoot: "/safe/link/new-instance",
    });
    const canonical = await canonicalizeDevRootSelection({ fs, selection });
    expect(canonical.rootPath).toBe("/target/new-instance");
    expect(canonical.requestedRootPath).toBe("/safe/link/new-instance");
    const result = await validateDevRootSelection({
      fs,
      selection: canonical,
      existingState: null,
      stateLoadStatus: "absent",
      protectedPaths: {
        explodexHome: "/Users/author/.explodex",
        userCodexHome: "/Users/author/.codex",
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "root_symlink",
      fallbackUsed: false,
    });
  });
});
