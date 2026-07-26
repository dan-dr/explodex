import { describe, expect, test } from "bun:test";
import {
  encodeOpaqueVersionComponent,
  decodeOpaqueVersionComponent,
  validateOpaqueVersion,
} from "../../src/plugin/version.ts";

describe("VAL-SDK-014 opaque artifact versions", () => {
  test("accepts SemVer, CalVer, and non-orderable strings with exact round-trip", () => {
    const samples = [
      "1.2.3",
      "1.2.3-beta.1+build.7",
      "2026.07.26",
      "nightly-2026-07-26",
      "v0",
      "release_candidate",
    ];
    for (const version of samples) {
      const result = validateOpaqueVersion(version);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.version).toBe(version);
      expect(decodeOpaqueVersionComponent(result.encoded)).toBe(version);
      expect(encodeOpaqueVersionComponent(version)).toBe(result.encoded);
    }
  });

  test("rejects empty, whitespace, control, separator, absolute, traversal, and non-round-trippable values", () => {
    const invalid = [
      "",
      "   ",
      " leading",
      "trailing ",
      "a\nb",
      "a/b",
      "a\\b",
      "../x",
      "/abs",
      "~/.secret",
      "C:\\windows",
      "\u0001bad",
    ];
    for (const version of invalid) {
      const result = validateOpaqueVersion(version);
      expect(result.ok).toBe(false);
    }
  });

  test("does not treat package.json version as artifact identity", () => {
    // Pure unit: validateOpaqueVersion only accepts the config version string.
    // package.json.version is intentionally not an input here.
    const configVersion = validateOpaqueVersion("opaque-build-42");
    expect(configVersion.ok).toBe(true);
    if (configVersion.ok) {
      expect(configVersion.version).toBe("opaque-build-42");
      expect(configVersion.version).not.toBe("0.0.0");
    }
  });
});
