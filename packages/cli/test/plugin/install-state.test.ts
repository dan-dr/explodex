import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createEmptyPluginsState,
  loadPluginsState,
  parsePluginsState,
  savePluginsStateAtomic,
} from "../../src/plugin/install-state.ts";
import { withTempDir } from "../../../sdk/test/helpers/pack.ts";

describe("M3-F02 plugins state", () => {
  test("strictly parses exact disabled installation authority", () => {
    const state = {
      schemaVersion: 1 as const,
      plugins: {
        sample: {
          installed: [
            {
              version: "opaque+1",
              payloadSha256: "11".repeat(32),
              archiveSha256: "22".repeat(32),
              relativePath: `plugins/sample/opaque+1-${"11".repeat(32)}`,
              source: { kind: "local" as const, archiveName: "sample.tar.gz" },
              installedAt: "2026-07-27T00:00:00.000Z",
            },
          ],
          enabled: null,
          pendingReview: [{ version: "opaque+1", payloadSha256: "11".repeat(32) }],
        },
      },
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    expect(parsePluginsState(state)).toEqual(state);
    expect(parsePluginsState({ ...state, schemaVersion: 2 })).toBeNull();
    expect(parsePluginsState({ ...state, token: "secret" })).toBeNull();
    expect(
      parsePluginsState({
        ...state,
        plugins: { sample: { ...state.plugins.sample, enabled: { version: "other", payloadSha256: "33".repeat(32) } } },
      }),
    ).toBeNull();
  });

  test("writes one complete private old-or-new JSON file", async () => {
    await withTempDir("explodex-install-state-", async (root) => {
      const home = join(root, "home");
      const first = createEmptyPluginsState("2026-07-27T00:00:00.000Z");
      await savePluginsStateAtomic({ explodexHome: home, state: first });
      const path = join(home, "state", "plugins.json");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first);

      const loaded = await loadPluginsState({ explodexHome: home });
      expect(loaded).toEqual({ status: "valid", state: first });
      expect(await loadPluginsState({ explodexHome: join(root, "missing") })).toEqual({ status: "missing" });
    });
  });

  test("faults at every atomic write phase expose only complete old-or-new private state", async () => {
    await withTempDir("explodex-install-state-faults-", async (root) => {
      const phases = [
        "beforeSerialize",
        "beforeTempWrite",
        "beforeTempSync",
        "beforeRename",
        "beforeDirectorySync",
      ] as const;
      for (const phase of phases) {
        const home = join(root, phase);
        const first = createEmptyPluginsState("2026-07-27T00:00:00.000Z");
        const next = createEmptyPluginsState("2026-07-27T00:01:00.000Z");
        await savePluginsStateAtomic({ explodexHome: home, state: first });
        await expect(savePluginsStateAtomic({
          explodexHome: home,
          state: next,
          adapters: {
            [phase]() {
              throw new Error(`injected ${phase} fault`);
            },
          },
        })).rejects.toThrow(`injected ${phase} fault`);

        const path = join(home, "state", "plugins.json");
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        expect(parsed === null).toBe(false);
        expect([first.updatedAt, next.updatedAt]).toContain(parsed.updatedAt);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(
          (await readdir(join(home, "state"))).filter((entry) =>
            entry.startsWith(".plugins-")
          ),
        ).toEqual([]);
      }
    });
  });

  test("rejects public or symlinked state files as non-authoritative", async () => {
    await withTempDir("explodex-install-state-private-", async (root) => {
      const publicHome = join(root, "public-home");
      const publicState = createEmptyPluginsState("2026-07-27T00:00:00.000Z");
      await savePluginsStateAtomic({
        explodexHome: publicHome,
        state: publicState,
      });
      await chmod(join(publicHome, "state", "plugins.json"), 0o644);
      expect(await loadPluginsState({ explodexHome: publicHome })).toEqual({
        status: "malformed",
      });

      const linkedHome = join(root, "linked-home");
      const external = join(root, "external.json");
      await writeFile(external, `${JSON.stringify(publicState)}\n`, { mode: 0o600 });
      await mkdir(join(linkedHome, "state"), { recursive: true });
      await symlink(external, join(linkedHome, "state", "plugins.json"));
      expect(await loadPluginsState({ explodexHome: linkedHome })).toEqual({
        status: "malformed",
      });
    });
  });
});
