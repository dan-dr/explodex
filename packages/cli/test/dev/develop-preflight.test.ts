import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  runDevelopPreflight,
} from "../../src/dev/develop-preflight.ts";
import type { HostAdapters } from "../../src/host/adapters.ts";
import type { HostStatusAdapters } from "../../src/host/status.ts";
import type { CdpAdapter } from "../../src/cdp/adapters.ts";
import { buildPluginWorkspace } from "../../src/plugin/build.ts";
import {
  createValidWorkspace,
  SDK_PACKAGE_ROOT,
  writeWorkspaceFile,
} from "../plugin/helpers.ts";

function forbiddenLiveAdapters(): {
  hostAdapters: HostAdapters;
  statusAdapters: HostStatusAdapters;
  cdp: CdpAdapter;
} {
  const forbidden = new Proxy({}, {
    get() {
      throw new Error("live adapter accessed before workspace preflight");
    },
  });
  return {
    hostAdapters: forbidden as HostAdapters,
    statusAdapters: forbidden as HostStatusAdapters,
    cdp: forbidden as CdpAdapter,
  };
}

describe("M4-F04 develop preflight", () => {
  test("rejects a workspace overlapping normal Explodex state before CDP", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-overlap",
    });
    try {
      const adapters = forbiddenLiveAdapters();
      const result = await runDevelopPreflight({
        workspacePath: fixture.workspace,
        osHome: fixture.root,
        explodexHome: fixture.root,
        timeoutMs: 60_000,
        ...adapters,
      });
      expect(result).toEqual({
        ok: false,
        code: "develop.workspace-unsafe",
        message:
          "Plugin workspace overlaps protected application, state, profile, or development-instance paths.",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects stale dist before ownership or target inspection", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-stale-develop",
    });
    try {
      const built = await buildPluginWorkspace({
        workspacePath: fixture.workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);
      await writeWorkspaceFile(
        fixture.workspace,
        "src/index.ts",
        "export default { changed: true };\n",
      );
      const adapters = forbiddenLiveAdapters();
      const result = await runDevelopPreflight({
        workspacePath: fixture.workspace,
        osHome: join(fixture.root, "home"),
        explodexHome: join(fixture.root, "home", ".explodex"),
        explicitRoot: join(fixture.root, "dev-root"),
        timeoutMs: 60_000,
        ...adapters,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("develop.dist-stale");
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects a symlink workspace and validates explicit SDK source before watching", async () => {
    const fixture = await createValidWorkspace({
      name: "explodex-plugin-preflight-paths",
    });
    try {
      const alias = join(fixture.root, "workspace-alias");
      await symlink(fixture.workspace, alias);
      const adapters = forbiddenLiveAdapters();
      const symlinkResult = await runDevelopPreflight({
        workspacePath: alias,
        osHome: join(fixture.root, "home"),
        explodexHome: join(fixture.root, "home", ".explodex"),
        explicitRoot: join(fixture.root, "dev-root"),
        timeoutMs: 60_000,
        ...adapters,
      });
      expect(symlinkResult).toMatchObject({
        ok: false,
        code: "develop.workspace-unsafe",
      });

      const sdkResult = await runDevelopPreflight({
        workspacePath: fixture.workspace,
        sdkSourcePath: SDK_PACKAGE_ROOT,
        osHome: join(fixture.root, "home"),
        explodexHome: join(fixture.root, "home", ".explodex"),
        explicitRoot: join(fixture.root, "dev-root"),
        timeoutMs: 60_000,
        ...adapters,
      });
      expect(sdkResult).toEqual({
        ok: false,
        code: "develop.sdk-source-not-supported",
        message:
          "Local SDK development requires the dedicated ordered SDK generation workflow.",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
