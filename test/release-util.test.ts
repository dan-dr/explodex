import { describe, expect, it } from "bun:test";
import { validateTag, getChangelogNotes, checkRelease } from "../scripts/release-util";

describe("release-util tag validation", () => {
  it("classifies stable versions as latest", () => {
    const res = validateTag("v1.0.0");
    expect(res.version).toBe("1.0.0");
    expect(res.isPrerelease).toBe(false);
    expect(res.npmTag).toBe("latest");

    const res2 = validateTag("v2.3.4");
    expect(res2.version).toBe("2.3.4");
    expect(res2.isPrerelease).toBe(false);
    expect(res2.npmTag).toBe("latest");
  });

  it("classifies versions containing a prerelease component as next", () => {
    const res = validateTag("v1.0.0-alpha.1");
    expect(res.version).toBe("1.0.0-alpha.1");
    expect(res.isPrerelease).toBe(true);
    expect(res.npmTag).toBe("next");

    const res2 = validateTag("v2.3.4-beta");
    expect(res2.version).toBe("2.3.4-beta");
    expect(res2.isPrerelease).toBe(true);
    expect(res2.npmTag).toBe("next");

    const res3 = validateTag("v0.1.0-rc.0");
    expect(res3.version).toBe("0.1.0-rc.0");
    expect(res3.isPrerelease).toBe(true);
    expect(res3.npmTag).toBe("next");
  });

  it("fails on malformed tag", () => {
    expect(() => validateTag("1.0.0")).toThrow("Tag must start with 'v'");
    expect(() => validateTag("v1.0")).toThrow("Invalid SemVer version in tag");
    expect(() => validateTag("v1")).toThrow("Invalid SemVer version in tag");
    expect(() => validateTag("vabc")).toThrow("Invalid SemVer version in tag");
    expect(() => validateTag("v1.0.0.0")).toThrow("Invalid SemVer version in tag");
  });
});

describe("release-util changelog notes extraction", () => {
  const dummyChangelog = `# Changelog

## [Unreleased]
- Something unreleased

## [0.2.0] - 2026-06-28
### Added
- Feature A
- Feature B

## [0.1.0] - 2026-06-28
### Added
- Initial release
`;

  it("extracts exact version notes and trims whitespace", () => {
    const notes = getChangelogNotes("0.2.0", dummyChangelog);
    expect(notes).toBe(`### Added
- Feature A
- Feature B`);

    const notes2 = getChangelogNotes("0.1.0", dummyChangelog);
    expect(notes2).toBe(`### Added
- Initial release`);
  });

  it("fails on missing changelog entry", () => {
    expect(() => getChangelogNotes("0.3.0", dummyChangelog)).toThrow(
      "Changelog section for version '0.3.0' not found"
    );
  });

  it("fails on empty changelog section", () => {
    const emptyChangelog = `# Changelog

## [0.2.0] - 2026-06-28

## [0.1.0] - 2026-06-28
`;
    expect(() => getChangelogNotes("0.2.0", emptyChangelog)).toThrow(
      "Changelog section for version '0.2.0' is empty"
    );
  });

  it("rejects [Unreleased] as the release body", () => {
    const unreleasedInBody = `# Changelog

## [0.2.0] - 2026-06-28
Referencing [Unreleased] notes.
`;
    expect(() => getChangelogNotes("0.2.0", unreleasedInBody)).toThrow(
      "Changelog body contains '[Unreleased]' reference"
    );
  });
});

describe("release-util checkRelease workflow", () => {
  const dummyChangelog = `# Changelog

## [0.2.1] - 2026-06-28
- Fixed bug

## [0.2.0] - 2026-06-28
- Release notes
`;

  it("passes when tag matches package.json and changelog exists", () => {
    const res = checkRelease("v0.2.1", "0.2.1", dummyChangelog);
    expect(res.version).toBe("0.2.1");
    expect(res.npmTag).toBe("latest");
    expect(res.notes).toBe("- Fixed bug");
  });

  it("fails on version mismatch", () => {
    expect(() => checkRelease("v0.2.1", "0.2.0", dummyChangelog)).toThrow(
      "Tag 'v0.2.1' does not match package.json version 'v0.2.0'"
    );
  });
});
