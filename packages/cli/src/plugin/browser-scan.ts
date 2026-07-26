/**
 * Source-free browser-safety scan of a generated classic-script plugin IIFE.
 * Shared by build-time bundling evidence and standalone artifact validation.
 */

const PRIVATE_GLOBAL_MARKERS = [
  "__EXPLODEX_PLUGIN_CATALOG__",
  "__EXPLODEX_PATHS__",
  "__EXPLODEX_BRIDGE__",
] as const;

const FORBIDDEN_PRIMITIVES = [
  "require(",
  "module.exports",
  "process.",
  "Buffer.",
  "Bun.",
  "node:",
  "bun:",
  "electron.",
] as const;

export type BrowserScanResult =
  | { ok: true }
  | { ok: false; message: string; marker: string };

/**
 * Reject forbidden Node/Bun/Electron/private-renderer primitives in installable JS.
 * Does not execute the bundle.
 */
export function scanBrowserSafeIife(source: string): BrowserScanResult {
  for (const marker of PRIVATE_GLOBAL_MARKERS) {
    if (source.includes(marker)) {
      return {
        ok: false,
        message: `Plugin bundle references forbidden private renderer global: ${marker}`,
        marker,
      };
    }
  }
  for (const marker of FORBIDDEN_PRIMITIVES) {
    if (source.includes(marker)) {
      return {
        ok: false,
        message: `Plugin bundle references forbidden runtime primitive: ${marker}`,
        marker,
      };
    }
  }
  // Absolute POSIX paths that look like workspace/home leakage.
  if (/["'`]\/(?:Users|home|var|tmp|private)\//.test(source)) {
    return {
      ok: false,
      message: "Plugin bundle embeds non-portable absolute filesystem paths",
      marker: "absolute-path",
    };
  }
  return { ok: true };
}
