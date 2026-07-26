/**
 * Lightweight source import scan for non-public package imports.
 * Full browser bundling/rejection of Node chains is owned by later features.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PUBLIC_SDK_SPECIFIERS = new Set(["@explodex/sdk", "@explodex/sdk/runtime"]);

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

export type ImportScanResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

export async function scanEntryImports(options: {
  workspacePath: string;
  entryRelative: string;
}): Promise<ImportScanResult> {
  const entryPath = join(options.workspacePath, options.entryRelative);
  let source: string;
  try {
    source = await readFile(entryPath, "utf8");
  } catch {
    return {
      ok: false,
      code: "plugin.source.invalid",
      message: `Entry file is missing: ${options.entryRelative}`,
      details: { entry: options.entryRelative },
    };
  }

  const matches = source.matchAll(IMPORT_RE);
  for (const match of matches) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) continue;
    if (specifier.startsWith("@explodex/sdk/")) {
      if (!PUBLIC_SDK_SPECIFIERS.has(specifier)) {
        return {
          ok: false,
          code: "plugin.source.invalid",
          message: `Non-public @explodex/sdk import is not allowed: ${specifier}`,
          details: { specifier, entry: options.entryRelative },
        };
      }
    }
    // Bare undeclared deep package internals that look private.
    if (
      specifier.includes("/src/") ||
      specifier.includes("/dist/internal") ||
      specifier.endsWith("/internal")
    ) {
      return {
        ok: false,
        code: "plugin.source.invalid",
        message: `Non-public import is not allowed: ${specifier}`,
        details: { specifier, entry: options.entryRelative },
      };
    }
  }

  return { ok: true };
}
