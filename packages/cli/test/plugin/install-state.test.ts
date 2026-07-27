import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
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
              relativePath: "plugins/sample/opaque+1-111111111111",
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
});
