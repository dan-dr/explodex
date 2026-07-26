import { describe, expect, test } from "bun:test";
import {
  createInitialDevInstanceState,
  describeDevLayout,
  ensureDefaultDevLayout,
  loadDevInstanceState,
  parseDevInstanceState,
  publicDevStateKeySet,
  saveDevInstanceState,
} from "../../src/dev/index.ts";
import type { HostAdapters } from "../../src/host/adapters.ts";
import { createFixedClock, createMemoryHash, MemoryFileSystem } from "../host/fixture-fs.ts";

function adaptersFor(fs: MemoryFileSystem): HostAdapters {
  return {
    fs,
    process: {
      async execFile() {
        return { stdout: "", stderr: "unused", exitCode: 1 };
      },
    },
    clock: createFixedClock("2026-07-25T12:00:00.000Z"),
    hash: createMemoryHash(),
  };
}

describe("development state (VAL-DEV-003)", () => {
  test("initial state is stopped, secret-free, and uses only the documented key set", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/state-a/.explodex/dev/plugin-dev";
    const layoutResult = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(layoutResult.ok).toBe(true);
    if (!layoutResult.ok) return;

    const state = createInitialDevInstanceState({
      layout: layoutResult.layout,
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });

    expect(state.status).toBe("stopped");
    expect(state.pid).toBeNull();
    expect(state.cdpPort).toBe(9444);
    expect(state.cdpHost).toBe("127.0.0.1");
    expect(state.role).toBe("development");
    expect(Object.keys(state).sort()).toEqual(
      publicDevStateKeySet().filter((key) => key !== "lastError").sort(),
    );

    const adapters = adaptersFor(fs);
    await saveDevInstanceState({
      adapters,
      statePath: layoutResult.layout.statePath,
      state,
    });
    const loaded = await loadDevInstanceState({
      adapters,
      statePath: layoutResult.layout.statePath,
    });
    expect(loaded).toEqual(state);

    const fileStat = await fs.stat(layoutResult.layout.statePath);
    expect(fileStat.kind).toBe("file");
    expect(fileStat.mode).toBe(0o600);
  });

  test("rejects secret-bearing or supervisor-control fields", () => {
    const layout = describeDevLayout("/tmp/homes/state-b/.explodex/dev/plugin-dev");
    const base = createInitialDevInstanceState({
      layout,
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });

    expect(
      parseDevInstanceState({
        ...base,
        token: "should-not-persist",
      }),
    ).toBeNull();
    expect(
      parseDevInstanceState({
        ...base,
        supervisorPid: 1,
      }),
    ).toBeNull();
    expect(
      parseDevInstanceState({
        ...base,
        environment: { OPENAI_API_KEY: "x" },
      }),
    ).toBeNull();
    expect(
      parseDevInstanceState({
        ...base,
        pluginSource: "console.log(1)",
      }),
    ).toBeNull();
  });

  test("failed write leaves the previous complete state (atomic rename)", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/state-c/.explodex/dev/plugin-dev";
    const layoutResult = await ensureDefaultDevLayout({ fs, rootPath: root });
    expect(layoutResult.ok).toBe(true);
    if (!layoutResult.ok) return;
    const adapters = adaptersFor(fs);

    const first = createInitialDevInstanceState({
      layout: layoutResult.layout,
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    await saveDevInstanceState({
      adapters,
      statePath: layoutResult.layout.statePath,
      state: first,
    });

    const originalRename = fs.rename.bind(fs);
    fs.rename = async () => {
      throw new Error("simulated rename failure");
    };

    const second = {
      ...first,
      status: "starting" as const,
      updatedAt: "2026-07-25T12:00:01.000Z",
    };
    await expect(
      saveDevInstanceState({
        adapters,
        statePath: layoutResult.layout.statePath,
        state: second,
      }),
    ).rejects.toThrow(/rename failure/);

    fs.rename = originalRename;
    const loaded = await loadDevInstanceState({
      adapters,
      statePath: layoutResult.layout.statePath,
    });
    expect(loaded).toEqual(first);
    expect(loaded?.status).toBe("stopped");
  });

  test("malformed JSON is treated as absent rather than partially promoted", async () => {
    const fs = new MemoryFileSystem();
    const path = "/tmp/homes/state-d/.explodex/dev/plugin-dev/state.json";
    fs.seedFile(path, "{not-json", 0o600);
    const loaded = await loadDevInstanceState({
      adapters: adaptersFor(fs),
      statePath: path,
    });
    expect(loaded).toBeNull();
  });

  test("stopped state parsing requires pid, start identity, target, and startedAt all null", () => {
    const layout = describeDevLayout("/tmp/homes/state-e/.explodex/dev/plugin-dev");
    const base = createInitialDevInstanceState({
      layout,
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    expect(base.status).toBe("stopped");
    expect(parseDevInstanceState(base)).not.toBeNull();
    expect(parseDevInstanceState({ ...base, pid: 123 })).toBeNull();
    expect(parseDevInstanceState({ ...base, processStartedAt: "start" })).toBeNull();
    expect(parseDevInstanceState({ ...base, targetId: "t" })).toBeNull();
    expect(parseDevInstanceState({ ...base, startedAt: "2026-07-25T12:00:00.000Z" })).toBeNull();
  });
});
