import { describe, expect, test } from "bun:test";
import {
  compareSemVer,
  currentSdkSatisfiesRange,
  evaluateSdkCompatibility,
  parseSemVer,
  satisfiesSdkRange,
} from "../../src/compatibility.ts";
import { SDK_VERSION } from "../../src/version.ts";
import * as publicSurface from "../../src/index.ts";

describe("VAL-SDK-008 shared compatibility authority", () => {
  test("authoritative SDK_VERSION is exported and used by currentSdkSatisfiesRange", () => {
    expect(SDK_VERSION).toBe("1.2.0");
    expect(publicSurface.SDK_VERSION).toBe(SDK_VERSION);
    expect(currentSdkSatisfiesRange("^1.2.0")).toBe(true);
    expect(currentSdkSatisfiesRange("^2.0.0")).toBe(false);
  });

  test("parseSemVer fails closed on unknown and malformed inputs", () => {
    expect(parseSemVer(undefined)).toBeNull();
    expect(parseSemVer(null)).toBeNull();
    expect(parseSemVer(1.2)).toBeNull();
    expect(parseSemVer("")).toBeNull();
    expect(parseSemVer("  ")).toBeNull();
    expect(parseSemVer("1")).toBeNull();
    expect(parseSemVer("1.2")).toBeNull();
    expect(parseSemVer("01.2.3")).toBeNull();
    expect(parseSemVer("v1.2.3")).toBeNull();
    expect(parseSemVer("1.2.3.4")).toBeNull();
    expect(parseSemVer("not-a-version")).toBeNull();
  });

  test("parseSemVer accepts strict SemVer including prerelease and build metadata", () => {
    expect(parseSemVer("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: undefined,
    });
    expect(parseSemVer("1.2.3-alpha.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["alpha", "1"],
      build: undefined,
    });
    expect(parseSemVer("1.2.3+build.9")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: "build.9",
    });
    expect(parseSemVer("1.2.3-rc.1+meta")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["rc", "1"],
      build: "meta",
    });
  });

  test("compareSemVer orders cores and prereleases; build is ignored", () => {
    const a = parseSemVer("1.2.3")!;
    const b = parseSemVer("1.2.4")!;
    const c = parseSemVer("1.2.3-alpha")!;
    const d = parseSemVer("1.2.3+build")!;
    expect(compareSemVer(a, b)).toBe(-1);
    expect(compareSemVer(b, a)).toBe(1);
    expect(compareSemVer(c, a)).toBe(-1);
    expect(compareSemVer(a, c)).toBe(1);
    expect(compareSemVer(a, d)).toBe(0);
  });

  test("inclusive and exclusive range boundaries", () => {
    const cases: Array<{ version: string; range: string; expected: boolean }> = [
      { version: "1.2.0", range: ">=1.2.0", expected: true },
      { version: "1.2.0", range: ">1.2.0", expected: false },
      { version: "1.2.0", range: "<=1.2.0", expected: true },
      { version: "1.2.0", range: "<1.2.0", expected: false },
      { version: "1.2.0", range: "=1.2.0", expected: true },
      { version: "1.2.0", range: "1.2.0", expected: true },
      { version: "1.2.1", range: ">=1.2.0 <1.3.0", expected: true },
      { version: "1.3.0", range: ">=1.2.0 <1.3.0", expected: false },
      { version: "1.2.0", range: "^1.2.0", expected: true },
      { version: "1.9.9", range: "^1.2.0", expected: true },
      { version: "2.0.0", range: "^1.2.0", expected: false },
      { version: "1.2.9", range: "~1.2.0", expected: true },
      { version: "1.3.0", range: "~1.2.0", expected: false },
      { version: "0.2.1", range: "^0.2.0", expected: true },
      { version: "0.3.0", range: "^0.2.0", expected: false },
      { version: "0.0.2", range: "^0.0.1", expected: false },
      { version: "1.5.0", range: "^1.0.0 || ^2.0.0", expected: true },
      { version: "2.1.0", range: "^1.0.0 || ^2.0.0", expected: true },
      { version: "3.0.0", range: "^1.0.0 || ^2.0.0", expected: false },
    ];
    for (const row of cases) {
      expect(satisfiesSdkRange(row.version, row.range)).toBe(row.expected);
    }
  });

  test("prereleases only match when explicitly admitted for the same core", () => {
    expect(satisfiesSdkRange("1.2.0-alpha.1", "^1.2.0")).toBe(false);
    expect(satisfiesSdkRange("1.2.0-alpha.1", ">=1.2.0")).toBe(false);
    expect(satisfiesSdkRange("1.2.0-alpha.1", ">=1.2.0-alpha.1")).toBe(true);
    expect(satisfiesSdkRange("1.2.0-alpha.2", ">=1.2.0-alpha.1 <1.2.0")).toBe(true);
    expect(satisfiesSdkRange("1.2.0", ">=1.2.0-alpha.1")).toBe(true);
    // Different core prerelease does not unlock a foreign prerelease runtime.
    expect(satisfiesSdkRange("1.3.0-beta.1", ">=1.2.0-alpha.1")).toBe(false);
  });

  test("build metadata does not invent ordering or break equality", () => {
    expect(satisfiesSdkRange("1.2.0+meta", "1.2.0")).toBe(true);
    expect(satisfiesSdkRange("1.2.0+meta", "^1.2.0")).toBe(true);
    expect(satisfiesSdkRange("1.2.0+build.1", ">=1.2.0 <1.2.1")).toBe(true);
    expect(satisfiesSdkRange("1.2.1+build.1", ">=1.2.0 <1.2.1")).toBe(false);
  });

  test("unknown and malformed range inputs fail closed", () => {
    expect(satisfiesSdkRange("1.2.0", undefined)).toBe(false);
    expect(satisfiesSdkRange("1.2.0", null)).toBe(false);
    expect(satisfiesSdkRange("1.2.0", "")).toBe(false);
    expect(satisfiesSdkRange("1.2.0", "   ")).toBe(false);
    expect(satisfiesSdkRange("1.2.0", 12)).toBe(false);
    expect(satisfiesSdkRange("1.2.0", "not a range")).toBe(false);
    expect(satisfiesSdkRange("1.2.0", ">=bogus")).toBe(false);
    expect(satisfiesSdkRange("1.2.0", "^")).toBe(false);
    expect(satisfiesSdkRange(undefined, "^1.0.0")).toBe(false);
    expect(satisfiesSdkRange("", "^1.0.0")).toBe(false);
    expect(satisfiesSdkRange("1.2", "^1.0.0")).toBe(false);
  });

  test("evaluateSdkCompatibility distinguishes fail-closed reasons", () => {
    expect(evaluateSdkCompatibility(undefined, "^1.0.0").reason).toBe("version-missing");
    expect(evaluateSdkCompatibility(null, "^1.0.0").reason).toBe("version-missing");
    expect(evaluateSdkCompatibility("", "^1.0.0").reason).toBe("version-missing");
    expect(evaluateSdkCompatibility("1.2", "^1.0.0").reason).toBe("version-malformed");
    expect(evaluateSdkCompatibility(42, "^1.0.0").reason).toBe("version-malformed");
    expect(evaluateSdkCompatibility("1.2.0", undefined).reason).toBe("range-missing");
    expect(evaluateSdkCompatibility("1.2.0", "").reason).toBe("range-missing");
    expect(evaluateSdkCompatibility("1.2.0", "!!!").reason).toBe("range-malformed");
    expect(evaluateSdkCompatibility("1.2.0", "^2.0.0").reason).toBe("out-of-range");

    const ok = evaluateSdkCompatibility("1.2.0", "^1.2.0");
    expect(ok).toEqual({ ok: true, version: "1.2.0", range: "^1.2.0" });
  });
});
