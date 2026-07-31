import { describe, expect, test } from "bun:test";
import {
  createInitialDevInstanceState,
  describeDevLayout,
  ensureDefaultDevLayout,
  loadDevInstanceState,
  loadDevInstanceStateResult,
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

  test("rejects an unsafe temporary inode before publishing canonical state", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/state-mode/.explodex/dev/plugin-dev";
    const layoutResult = await ensureDefaultDevLayout({ fs, rootPath: root });
    if (!layoutResult.ok) throw new Error(layoutResult.error.message);
    const adapters = adaptersFor(fs);
    const state = createInitialDevInstanceState({
      layout: layoutResult.layout,
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    const originalWrite = fs.writeFile.bind(fs);
    let renameCalled = false;
    fs.writeFile = async (path, data) => {
      await originalWrite(path, data);
      fs.seedFile(
        path,
        typeof data === "string" ? data : new TextDecoder().decode(data),
        0o644,
      );
    };
    fs.rename = async () => {
      renameCalled = true;
    };
    await expect(saveDevInstanceState({
      adapters,
      statePath: layoutResult.layout.statePath,
      state,
    })).rejects.toThrow(/mode must be private/);
    expect(renameCalled).toBe(false);
    expect(await loadDevInstanceState({
      adapters,
      statePath: layoutResult.layout.statePath,
    })).toBeNull();
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

  test("loads the older schema-1 ready shape as failed recovery authority", async () => {
    const fs = new MemoryFileSystem();
    const root = "/tmp/homes/state-legacy/.explodex/dev/plugin-dev";
    const layout = describeDevLayout(root);
    const legacy = {
      schemaVersion: 1,
      instanceId: "plugin-dev",
      role: "development",
      status: "ready",
      rootPath: root,
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      pid: 20441,
      processStartedAt: "legacy-start",
      launchMarker: "--explodex-dev-instance=plugin-dev",
      electronUserDataPath: layout.electronUserDataPath,
      codexHomePath: layout.codexHomePath,
      explodexStatePath: layout.explodexStatePath,
      logsPath: layout.logsPath,
      cdpHost: "127.0.0.1",
      cdpPort: 9444,
      targetId: "legacy-target",
      appVersion: "26.721.41059",
      appBuild: "5848",
      startedAt: "2026-07-26T14:30:18.911Z",
      updatedAt: "2026-07-26T14:30:18.911Z",
    };
    fs.seedFile(layout.statePath, JSON.stringify(legacy), 0o600);

    const loaded = await loadDevInstanceStateResult({
      adapters: adaptersFor(fs),
      statePath: layout.statePath,
    });
    expect(loaded.status).toBe("valid");
    if (loaded.status !== "valid") return;
    expect(loaded.state).toMatchObject({
      status: "failed",
      pid: 20441,
      processStartedAt: "legacy-start",
      targetId: null,
      browserIdentity: null,
      executionContextUniqueId: null,
      frozenHost: null,
      recoveryDiagnostics: [],
      lastError: {
        code: "dev.state-migrated",
        phase: "state-migration",
      },
    });
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

  test("starting state may persist raw spawn PID before kernel start identity is known", () => {
    const layout = describeDevLayout("/tmp/homes/state-spawn/.explodex/dev/plugin-dev");
    const base = createInitialDevInstanceState({
      layout,
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      updatedAt: "2026-07-25T12:00:00.000Z",
    });
    const starting = {
      ...base,
      status: "starting" as const,
      pid: 95404,
      processStartedAt: null,
      startedAt: "2026-07-25T12:00:01.000Z",
      updatedAt: "2026-07-25T12:00:01.000Z",
    };
    expect(parseDevInstanceState(starting)).toEqual(starting);
    expect(parseDevInstanceState({
      ...starting,
      pid: null,
      processStartedAt: "impossible-without-pid",
    })).toBeNull();
  });
});
