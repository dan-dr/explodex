import { describe, expect, test } from "bun:test";
import {
  classifyDevelopmentOwnership,
  controlledOwnershipNegatives,
} from "../../src/dev/ownership.ts";

const EXPECTED = {
  marker: "--explodex-dev-instance=plugin-dev",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  cdpHost: "127.0.0.1" as const,
  cdpPort: 9444 as const,
  expectedPid: 4242,
  expectedProcessStartedAt: "dev-start-identity",
};

describe("Phase 0 ownership classifier", () => {
  test("accepts the positive development identity with complete readiness fields", () => {
    const verdict = classifyDevelopmentOwnership({
      role: "development",
      pid: 4242,
      processStartedAt: "dev-start-identity",
      executablePath: EXPECTED.executablePath,
      arguments: [
        EXPECTED.executablePath,
        "--user-data-dir=/tmp/dev",
        "--remote-debugging-port=9444",
        EXPECTED.marker,
      ],
      portOwnerPid: 4242,
      port: 9444,
      endpointHost: "127.0.0.1",
      browserIdentity: "Chrome/ChatGPT",
      targetIds: ["target-1"],
      defaultExecutionContextCount: 1,
      expected: EXPECTED,
    });
    expect(verdict.owned).toBe(true);
    expect(verdict.code).toBe("owned");
  });

  test("derives protected-main, unrelated, substring, pid-reuse, wrong-endpoint, and conflicting-source negatives without mutation", () => {
    const negatives = controlledOwnershipNegatives({
      expected: EXPECTED,
      developmentPid: 4242,
      developmentStartedAt: "dev-start-identity",
    });
    expect(negatives).toHaveLength(6);

    const codes = negatives.map((candidate) => {
      const verdict = classifyDevelopmentOwnership(candidate);
      expect(verdict.owned).toBe(false);
      return { role: candidate.role, code: verdict.code };
    });

    expect(codes).toEqual([
      { role: "protected-main", code: "protected_main" },
      { role: "unrelated", code: "unrelated_marker" },
      { role: "arbitrary-substring", code: "arbitrary_substring" },
      { role: "pid-reuse", code: "pid_reuse" },
      { role: "wrong-endpoint", code: "wrong_endpoint" },
      { role: "conflicting-source", code: "conflicting_source" },
    ]);
  });

  test("null target or browser identity leaves development unowned", () => {
    const missingTarget = classifyDevelopmentOwnership({
      role: "development",
      pid: 4242,
      processStartedAt: "dev-start-identity",
      executablePath: EXPECTED.executablePath,
      arguments: [EXPECTED.executablePath, EXPECTED.marker, "--remote-debugging-port=9444"],
      portOwnerPid: 4242,
      port: 9444,
      endpointHost: "127.0.0.1",
      browserIdentity: "Chrome/ChatGPT",
      targetIds: [],
      defaultExecutionContextCount: 1,
      expected: EXPECTED,
    });
    expect(missingTarget.owned).toBe(false);
    expect(missingTarget.code).toBe("missing_identity");

    const multiTarget = classifyDevelopmentOwnership({
      role: "development",
      pid: 4242,
      processStartedAt: "dev-start-identity",
      executablePath: EXPECTED.executablePath,
      arguments: [EXPECTED.executablePath, EXPECTED.marker, "--remote-debugging-port=9444"],
      portOwnerPid: 4242,
      port: 9444,
      endpointHost: "127.0.0.1",
      browserIdentity: "Chrome/ChatGPT",
      targetIds: ["a", "b"],
      defaultExecutionContextCount: 1,
      expected: EXPECTED,
    });
    expect(multiTarget.owned).toBe(false);
    expect(multiTarget.code).toBe("ambiguous_targets");
  });
});
