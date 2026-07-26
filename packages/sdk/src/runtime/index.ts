/**
 * Browser IIFE entry. Bundled as a classic script with no loader dependency.
 * Must not import Node, Bun, Electron, or filesystem modules.
 */
import { installRuntime } from "./bootstrap.ts";

type BrowserGlobal = typeof globalThis & {
  window?: typeof globalThis;
  Explodex?: unknown;
  console: Console;
};

function resolveHost(): BrowserGlobal {
  const candidate = globalThis as BrowserGlobal;
  if (typeof candidate.window === "object" && candidate.window !== null) {
    return candidate.window as BrowserGlobal;
  }
  return candidate;
}

const host = resolveHost();
installRuntime(host as Parameters<typeof installRuntime>[0]);
