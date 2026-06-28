import { describe, expect, test } from "bun:test";
import { decideLaunchState } from "../lib/platform.mjs";
import { installedCodexEnvironment } from "../lib/platform/macos.mjs";

describe("launch state decisions", () => {
  test.each([
    [{ portListening: false, portOwnedByCodex: false, codexRunning: false }, "stopped"],
    [{ portListening: true, portOwnedByCodex: true, codexRunning: true }, "debug-codex"],
    [{ portListening: false, portOwnedByCodex: false, codexRunning: true }, "plain-codex"],
    [{ portListening: true, portOwnedByCodex: false, codexRunning: true }, "foreign-port"],
  ])("maps %o to %s", (input, expected) => expect(decideLaunchState(input)).toBe(expected));
});

test("installed mode removes dev profile overrides", () => {
  expect(installedCodexEnvironment({ HOME: "/tmp/home", CODEX_ELECTRON_USER_DATA_PATH: "/tmp/dev", EXPLODEX_USER_DATA: "/tmp/dev" })).toEqual({ HOME: "/tmp/home" });
});
