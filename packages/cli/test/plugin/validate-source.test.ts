import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePluginSource } from "../../src/plugin/validate.ts";
import { captureCli, parseStdoutJson } from "../helpers/run-cli.ts";
import { createValidWorkspace, writeWorkspaceFile } from "./helpers.ts";

async function distFingerprint(workspace: string): Promise<string> {
  try {
    const bytes = await readFile(join(workspace, "dist", "index.js"));
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return "missing";
  }
}

describe("VAL-SDK-012/013 source validation", () => {
  test("valid workspace reports derived ID, config version, peer range, lifecycle, entry", async () => {
    const fixture = await createValidWorkspace({ withDist: true });
    try {
      const before = await distFingerprint(fixture.workspace);
      const result = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.id).toBe("sample");
      expect(result.report.packageName).toBe("explodex-plugin-sample");
      expect(result.report.version).toBe("0.1.0");
      expect(result.report.lifecycle).toBe("dynamic");
      expect(result.report.sdkRange).toMatch(/\d+\.\d+\.\d+/);
      expect(result.report.entry).toBe("src/index.ts");
      expect(result.report.configExecutions).toBe(1);
      expect(result.report.packageManagerVersion).toBe("0.0.0");
      expect(result.report.hotSetupAllowed).toBe(true);
      const after = await distFingerprint(fixture.workspace);
      expect(after).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });

  test("config executes exactly once and leaves dist unchanged on failure", async () => {
    const fixture = await createValidWorkspace({ withDist: true });
    try {
      const canary = join(fixture.workspace, "config-load-canary.txt");
      await writeWorkspaceFile(
        fixture.workspace,
        "explodex.config.ts",
        `import { appendFileSync } from "node:fs";
import { defineConfig } from "@explodex/sdk";
appendFileSync(${JSON.stringify(canary)}, "load\\n");
export default defineConfig({
  version: "0.1.0",
  displayName: "Sample",
  description: "once",
  lifecycle: "dynamic",
});
`,
      );

      const before = await distFingerprint(fixture.workspace);
      const ok = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(ok.ok).toBe(true);
      const canaryText = await readFile(canary, "utf8");
      expect(canaryText).toBe("load\n");

      // Failure path: syntax error; dist must remain byte-identical.
      await writeWorkspaceFile(
        fixture.workspace,
        "explodex.config.ts",
        `import { appendFileSync } from "node:fs";
import { defineConfig } from "@explodex/sdk";
appendFileSync(${JSON.stringify(canary)}, "load\\n");
export default defineConfig({
  version: "0.1.0",
  displayName: "Sample",
  description: "broken"
  lifecycle: "dynamic",
});
`,
      );
      const failed = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(failed.ok).toBe(false);
      const after = await distFingerprint(fixture.workspace);
      expect(after).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });

  test("does not run package lifecycle scripts during validation", async () => {
    const fixture = await createValidWorkspace();
    try {
      const packagePath = join(fixture.workspace, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<
        string,
        unknown
      >;
      const canary = join(fixture.workspace, "lifecycle-script-canary.txt");
      packageJson.scripts = {
        preinstall: `echo preinstall >> ${JSON.stringify(canary)}`,
        install: `echo install >> ${JSON.stringify(canary)}`,
        postinstall: `echo postinstall >> ${JSON.stringify(canary)}`,
        prepare: `echo prepare >> ${JSON.stringify(canary)}`,
      };
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

      const result = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(result.ok).toBe(true);
      await expect(readFile(canary, "utf8")).rejects.toBeDefined();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects folder/package mismatch, missing peer range, and config id override without touching dist", async () => {
    const fixture = await createValidWorkspace({ withDist: true });
    try {
      const before = await distFingerprint(fixture.workspace);

      // Folder/package mismatch
      const packagePath = join(fixture.workspace, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<
        string,
        unknown
      >;
      packageJson.name = "explodex-plugin-other";
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      const mismatch = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(mismatch.ok).toBe(false);
      expect(await distFingerprint(fixture.workspace)).toBe(before);

      // Restore name, remove peer range
      packageJson.name = "explodex-plugin-sample";
      delete (packageJson as { peerDependencies?: unknown }).peerDependencies;
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      const noPeer = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(noPeer.ok).toBe(false);
      expect(await distFingerprint(fixture.workspace)).toBe(before);

      // Restore peers, inject config id override
      packageJson.peerDependencies = { "@explodex/sdk": "^1.2.0" };
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      await writeWorkspaceFile(
        fixture.workspace,
        "explodex.config.ts",
        `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  id: "hijack",
  version: "0.1.0",
  displayName: "Sample",
  description: "no",
  lifecycle: "dynamic",
} as never);
`,
      );
      const idOverride = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(idOverride.ok).toBe(false);
      expect(await distFingerprint(fixture.workspace)).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects local/workspace peer ranges and non-public imports", async () => {
    const fixture = await createValidWorkspace();
    try {
      const packagePath = join(fixture.workspace, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
        peerDependencies: Record<string, string>;
      };
      packageJson.peerDependencies["@explodex/sdk"] = "workspace:*";
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      const localPeer = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(localPeer.ok).toBe(false);

      packageJson.peerDependencies["@explodex/sdk"] = "^1.2.0";
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      await writeWorkspaceFile(
        fixture.workspace,
        "src/index.ts",
        `import { definePlugin } from "@explodex/sdk/src/internal";
export default definePlugin({ setup() {} });
`,
      );
      const deepImport = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(deepImport.ok).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("preserves opaque config version and ignores package.json.version as identity", async () => {
    const fixture = await createValidWorkspace();
    try {
      const packagePath = join(fixture.workspace, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
        version: string;
      };
      packageJson.version = "9.9.9";
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      await writeWorkspaceFile(
        fixture.workspace,
        "explodex.config.ts",
        `import { defineConfig } from "@explodex/sdk";
export default defineConfig({
  version: "nightly-2026-07-26",
  displayName: "Sample",
  description: "opaque",
  lifecycle: "dynamic",
});
`,
      );
      const result = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 15_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.version).toBe("nightly-2026-07-26");
      expect(result.report.packageManagerVersion).toBe("9.9.9");
      expect(result.report.version).not.toBe(result.report.packageManagerVersion);
    } finally {
      await fixture.cleanup();
    }
  });

  test("CLI plugin validate emits schemaVersion-1 success and failure envelopes", async () => {
    const fixture = await createValidWorkspace();
    try {
      const ok = await captureCli(
        ["--json", "plugin", "validate", fixture.workspace],
        { ...process.env, HOME: fixture.root },
      );
      expect(ok.exitCode).toBe(0);
      const okEnvelope = parseStdoutJson(ok.stdout) as {
        schemaVersion: number;
        ok: boolean;
        operation: string;
        result: { id: string; lifecycle: string };
      };
      expect(okEnvelope.schemaVersion).toBe(1);
      expect(okEnvelope.ok).toBe(true);
      expect(okEnvelope.operation).toBe("plugin.validate");
      expect(okEnvelope.result.id).toBe("sample");
      expect(okEnvelope.result.lifecycle).toBe("dynamic");

      await rm(join(fixture.workspace, "explodex.config.ts"));
      const bad = await captureCli(
        ["--json", "plugin", "validate", fixture.workspace],
        { ...process.env, HOME: fixture.root },
      );
      expect(bad.exitCode).not.toBe(0);
      const badEnvelope = parseStdoutJson(bad.stdout) as {
        schemaVersion: number;
        ok: boolean;
        operation: string;
        error: { code: string };
      };
      expect(badEnvelope.schemaVersion).toBe(1);
      expect(badEnvelope.ok).toBe(false);
      expect(badEnvelope.operation).toBe("plugin.validate");
      expect(badEnvelope.error.code).toBe("plugin.source.invalid");
    } finally {
      await fixture.cleanup();
    }
  });

  test("timeout on stalled config leaves dist unchanged", async () => {
    const fixture = await createValidWorkspace({ withDist: true });
    try {
      const before = await distFingerprint(fixture.workspace);
      await writeWorkspaceFile(
        fixture.workspace,
        "explodex.config.ts",
        `import { defineConfig } from "@explodex/sdk";
await new Promise(() => {});
export default defineConfig({
  version: "0.1.0",
  displayName: "Sample",
  description: "stall",
  lifecycle: "dynamic",
});
`,
      );
      const result = await validatePluginSource({
        workspacePath: fixture.workspace,
        timeoutMs: 500,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code === "operation.timeout" || result.code === "plugin.source.invalid").toBe(
          true,
        );
      }
      expect(await distFingerprint(fixture.workspace)).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });
});
