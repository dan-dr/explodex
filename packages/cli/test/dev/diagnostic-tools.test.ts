import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CDP_HOST,
  CDP_PORT,
  EXACT_RENDERER_URL,
  exactRendererTarget,
  type CdpTarget,
} from "../../../../scripts/cdp-client.ts";
import { REPO_ROOT } from "../package/helpers.ts";

const exactTarget: CdpTarget = {
  id: "exact",
  type: "page",
  url: EXACT_RENDERER_URL,
  webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/exact",
};

describe("isolated renderer diagnostic tools", () => {
  test("use only the exact development endpoint", () => {
    expect(CDP_HOST).toBe("127.0.0.1");
    expect(CDP_PORT).toBe(9444);
    expect(EXACT_RENDERER_URL).toBe("app://-/index.html");
    expect(exactRendererTarget([exactTarget])).toEqual(exactTarget);
  });

  test("reject missing, ambiguous, and non-app renderer targets", () => {
    expect(() => exactRendererTarget([])).toThrow("found 0");
    expect(() => exactRendererTarget([exactTarget, { ...exactTarget, id: "duplicate" }])).toThrow(
      "found 2",
    );
    expect(() =>
      exactRendererTarget([
        {
          ...exactTarget,
          type: "other",
          url: "devtools://devtools/bundled/inspector.html",
        },
      ]),
    ).toThrow("found 0");
  });

  test("all retained diagnostics share the guarded client and no authoring port fallback", async () => {
    for (const name of [
      "cdp-layout-snapshot.ts",
      "cdp-react-devtools.ts",
      "cdp-react-scan.ts",
    ]) {
      const path = join(REPO_ROOT, "scripts", name);
      const source = await readFile(path, "utf8");
      expect(source).toContain("openExactRendererSession");
      expect(source).not.toContain("9333");
      await import(path);
    }
  });
});
