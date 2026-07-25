import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_DEV_INSTANCE_ID,
  DEV_LAYOUT_DIRECTORIES,
  describeDevLayout,
  ensureDefaultDevLayout,
  ownershipFromLayoutOnly,
  resolveDefaultDevRoot,
} from "../../src/dev/index.ts";
import { MemoryFileSystem } from "../host/fixture-fs.ts";

describe("development layout (VAL-DEV-001)", () => {
  test("default root is ~/.explodex/dev/plugin-dev under the provided os home", () => {
    const root = resolveDefaultDevRoot({ osHome: "/tmp/user-home" });
    expect(root).toBe("/tmp/user-home/.explodex/dev/plugin-dev");
    expect(DEFAULT_DEV_INSTANCE_ID).toBe("plugin-dev");
  });

  test("creates only the canonical private descendants", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/a/.explodex/dev/plugin-dev";
    const result = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.grantsOwnership).toBe(false);
    expect(result.layout.rootPath).toBe(root);
    for (const directory of DEV_LAYOUT_DIRECTORIES) {
      const absolute = join(root, directory);
      const stat = await fs.stat(absolute);
      expect(stat.kind).toBe("directory");
      expect(stat.mode).toBe(0o700);
    }
    expect(result.layout.statePath).toBe(join(root, "state.json"));
    expect(result.layout.phase0ContractPath).toBe(
      join(root, "explodex-state", "phase0-launch-contract.json"),
    );
  });

  test("is idempotent and does not invent alternate roots or ports", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/b/.explodex/dev/plugin-dev";
    const first = await ensureDefaultDevLayout({ fs, rootPath: root });
    const second = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.layout).toEqual(first.layout);
    expect(second.created).toEqual([]);
    expect(second.layout.rootPath.endsWith("/dev/plugin-dev")).toBe(true);
  });

  test("rejects a symlink root without following it into protected space", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/c/.explodex/dev/plugin-dev";
    fs.seedSymlink(root, "/Users/dan/Library/Application Support/ChatGPT");
    const result = await ensureDefaultDevLayout({
      fs,
      rootPath: root,
      protectedPaths: {
        mainProfilePath: "/Users/dan/Library/Application Support/ChatGPT",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("root_symlink");
    expect(result.grantsOwnership).toBe(false);
  });

  test("rejects protected main profile / ~/.codex / normal Explodex home roots", async () => {
    const fs = new MemoryFileSystem();
    const cases = [
      {
        root: "/Users/dan/Library/Application Support/ChatGPT",
        protectedPaths: {
          mainProfilePath: "/Users/dan/Library/Application Support/ChatGPT",
        },
      },
      {
        root: "/Users/dan/.codex",
        protectedPaths: { userCodexHome: "/Users/dan/.codex" },
      },
      {
        root: "/Users/dan/.explodex",
        protectedPaths: { explodexHome: "/Users/dan/.explodex" },
      },
    ];
    for (const entry of cases) {
      const result = await ensureDefaultDevLayout({
        fs,
        rootPath: entry.root,
        protectedPaths: entry.protectedPaths,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("protected_path");
    }
  });

  test("path creation alone never grants ownership", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/d/.explodex/dev/plugin-dev";
    const result = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownership = ownershipFromLayoutOnly(result.layout);
    expect(ownership.owned).toBe(false);
    expect(ownership.reason).toBe("paths_only_insufficient");
  });

  test("describeDevLayout enumerates the exact public path set", () => {
    const layout = describeDevLayout("/tmp/x/.explodex/dev/plugin-dev");
    expect(Object.keys(layout).sort()).toEqual(
      [
        "codexHomePath",
        "electronUserDataPath",
        "explodexStatePath",
        "locksPath",
        "logsPath",
        "phase0ContractPath",
        "rootPath",
        "statePath",
      ].sort(),
    );
  });
});
