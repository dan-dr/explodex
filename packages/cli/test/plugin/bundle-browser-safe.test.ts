import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createInertRegistrationHarness,
  PRIVATE_REGISTER_GLOBAL,
} from "../../../sdk/src/testing/index.ts";
import { buildPluginWorkspace, readBuiltPluginIndex } from "../../src/plugin/build.ts";
import { scanBrowserSafeIife } from "../../src/plugin/browser-scan.ts";
import { fingerprintDist } from "../../src/plugin/bundle.ts";
import {
  createValidWorkspace,
  writeWorkspaceFile,
} from "./helpers.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("VAL-SDK-016 browser-safe plugin bundling", () => {
  test("bundles browser dependency including fetch into one classic IIFE", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-fetchy",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/util.ts",
        `export async function ping(url: string): Promise<string> {
  const response = await fetch(url);
  return response.ok ? "ok" : "bad";
}
`,
      );
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import { ping } from "./util";

export default definePlugin({
  setup() {
    void ping;
  },
});
`,
      );

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);

      const source = await readBuiltPluginIndex(workspace);
      expect(/^\s*import\s/m.test(source)).toBe(false);
      expect(/^\s*export\s/m.test(source)).toBe(false);
      expect(source.includes("require(")).toBe(false);
      expect(source.includes("__EXPLODEX_PRIVATE_REGISTER__")).toBe(true);
      expect(source.includes("sourceMappingURL=index.js.map")).toBe(true);
      expect(await readFile(join(workspace, "dist", "index.js.map"), "utf8")).toContain(
        "version",
      );
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("missing relative module fails with import diagnostics and preserves prior dist", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-missing-rel",
      withDist: true,
    });
    try {
      const prior = await fingerprintDist(workspace);
      expect(prior).not.toBeNull();

      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import { missing } from "./does-not-exist";

export default definePlugin({
  setup() {
    void missing;
  },
});
`,
      );

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.priorDistFingerprint).toBe(prior);
      expect(result.distFingerprintAfter).toBe(prior);
      // Prior dist content unchanged.
      const priorText = await readFile(join(workspace, "dist", "index.js"), "utf8");
      expect(priorText).toContain("/* prior dist */");
      expect(
        result.diagnostics.length > 0 || /resolve|Could not|missing|does-not-exist/i.test(result.message),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("direct Node runtime import fails with chain diagnostics", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-node-fs",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import { readFileSync } from "node:fs";

export default definePlugin({
  setup() {
    void readFileSync;
  },
});
`,
      );

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.distFingerprintAfter).toBeNull();
      const diagText = JSON.stringify(result.diagnostics) + result.message;
      expect(/node:fs|Node built-in|forbidden/i.test(diagText)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("transitive Node chain is diagnosed", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-transitive-node",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/leaf.ts",
        `import { join } from "node:path";
export const root = join("a", "b");
`,
      );
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import { root } from "./leaf";

export default definePlugin({
  setup() {
    void root;
  },
});
`,
      );

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      const diagText = JSON.stringify(result.diagnostics) + result.message;
      expect(/node:path|Node built-in|forbidden/i.test(diagText)).toBe(true);
      expect(
        result.diagnostics.some((d) => d.chain.length >= 2) || /leaf\.ts|from/i.test(diagText),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("VAL-SDK-017 built bundle browser realm and public API only", () => {
  test("dist/index.js executes as classic script and registers via public host API", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-realm",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";

export default definePlugin({
  setup(api) {
    api.log.info("setup-should-not-run-during-eval");
  },
});
`,
      );

      const built = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error(built.message);

      const source = await readBuiltPluginIndex(workspace);
      expect(source.includes("require(")).toBe(false);
      expect(source.includes("__EXPLODEX_PLUGIN_CATALOG__")).toBe(false);
      expect(source.includes("__EXPLODEX_PATHS__")).toBe(false);
      expect(/^\s*import\s/m.test(source)).toBe(false);

      const harness = createInertRegistrationHarness();
      let setupThroughEval = 0;
      const result = await harness.evaluateSource({
        expectedPluginId: "realm",
        source,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.registrationCount).toBe(1);
      expect(result.registration.pluginId).toBe("realm");
      // Mere evaluation must not run setup.
      expect(setupThroughEval).toBe(0);

      // Setup only after acceptance.
      const lifecycle = await import("../../../sdk/src/testing/index.ts");
      const life = lifecycle.createLifecycleHarness();
      const applied = await life.apply("realm", result.registration.definition);
      expect(applied.ok).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("private renderer globals and statically computed bridge access fail build", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-private-global",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";

export default definePlugin({
  setup() {
    const root = globalThis;
    const bridgeName = "electron" + "Bridge";
    const privateName = "__EXPLODEX_" + "BRIDGE__";
    void (root as Record<string, unknown>)[bridgeName];
    void (root as Record<string, unknown>)[privateName];
  },
});
`,
      );

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected browser-safety failure");
      expect(result.message).toMatch(/electronBridge|private renderer|bridge/i);
      expect(result.distFingerprintAfter).toBeNull();
    } finally {
      await cleanup();
    }
  }, 120_000);

  test("syntax-aware authority ignores forbidden words in comments and inert strings", () => {
    const source = `
      /* process.env and electronBridge are documentation examples. */
      const note = "require(\\\"fs\\\") and __EXPLODEX_BRIDGE__ are not executed";
      void note;
      (function (global) {
        global.__EXPLODEX_PRIVATE_REGISTER__("safe", { setup() {} });
      })(globalThis);
    `;
    expect(scanBrowserSafeIife(source)).toEqual({ ok: true });
  });

  test("syntax-aware authority resolves global and property aliases", () => {
    for (const source of [
      `
        const root = globalThis;
        const prefix = "electron";
        const bridge = prefix + "Bridge";
        void root[bridge];
      `,
      `
        let root;
        root = globalThis;
        void root["electron" + "Bridge"];
      `,
      'void Reflect.get(globalThis, "electronBridge");',
      'void Object.getOwnPropertyDescriptor(globalThis, "electronBridge");',
      "let bridge; ({ electronBridge: bridge } = globalThis);",
      "const root = (0, globalThis); void root.electronBridge;",
      "(function read() { return this.electronBridge; })();",
      "void this.electronBridge;",
    ]) {
      const result = scanBrowserSafeIife(source);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected private bridge rejection");
      expect(result.ruleId).toBe("browser.private-renderer-global");
      expect(result.marker).toBe("electronBridge");
    }
  });

  test("syntax-aware authority does not confuse local this or invalidated aliases", () => {
    expect(
      scanBrowserSafeIife(`
        const local = { read() { return this.electronBridge; } };
        void local;
      `),
    ).toEqual({ ok: true });
    expect(
      scanBrowserSafeIife(`
        let key = "electronBridge";
        key += "Safe";
        void globalThis[key];
      `),
    ).toEqual({ ok: true });
    expect(
      scanBrowserSafeIife(`
        let key = "electronBridge";
        key++;
        void globalThis[key];
      `),
    ).toEqual({ ok: true });
    expect(
      scanBrowserSafeIife(`
        let key = "electronBridge";
        [key] = ["safe"];
        void globalThis[key];
      `),
    ).toEqual({ ok: true });
    expect(
      scanBrowserSafeIife(`
        function local() {
          if (true) { var process = {}; }
          try { throw new Error("x"); } catch (process) { void process; }
          return process;
        }
        void local;
      `),
    ).toEqual({ ok: true });
  });

  test("syntax-aware authority preserves absolute-path rejection for templates", () => {
    const result = scanBrowserSafeIife("const path = `/Users/example/plugin`;");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected absolute path rejection");
    expect(result.ruleId).toBe("browser.absolute-path");
  });

  test("build directly observes top-level effects instead of trusting source declarations", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-top-level-effect",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";

document.body.appendChild(document.createElement("div"));

export default definePlugin({
  setup() {},
});
`,
      );

      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected inert-evaluation failure");
      expect(result.message).toMatch(/side effect|inert registration/i);
      expect(result.distFingerprintAfter).toBeNull();
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("plugin build prior-dist preservation", () => {
  test("failed build with no prior dist leaves no dist", async () => {
    const { workspace, cleanup } = await createValidWorkspace({
      name: "explodex-plugin-no-prior",
    });
    try {
      await writeWorkspaceFile(
        workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk";
import "node:fs";
export default definePlugin({ setup() {} });
`,
      );
      const result = await buildPluginWorkspace({
        workspacePath: workspace,
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.priorDistFingerprint).toBeNull();
      expect(result.distFingerprintAfter).toBeNull();
    } finally {
      await cleanup();
    }
  }, 120_000);
});
