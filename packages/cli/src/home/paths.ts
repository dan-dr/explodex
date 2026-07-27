import { join } from "node:path";

/**
 * Resolve the Explodex home directory for a given OS home or explicit override.
 * Tests always pass an isolated temporary home; production defaults to ~/.explodex.
 */
export function resolveExplodexHome(options: {
  osHome?: string;
  explodexHome?: string;
}): string {
  if (options.explodexHome !== undefined && options.explodexHome !== "") {
    return options.explodexHome;
  }
  const osHome = options.osHome;
  if (osHome === undefined || osHome === "") {
    throw new Error("osHome or explodexHome is required to resolve Explodex home");
  }
  return join(osHome, ".explodex");
}

export function compatibilityStatePath(explodexHome: string): string {
  return join(explodexHome, "state", "compatibility.json");
}

export function mainLaunchCoordinationPath(explodexHome: string): string {
  return join(explodexHome, "state", "main-launch-coordination.json");
}

export function stateDirectory(explodexHome: string): string {
  return join(explodexHome, "state");
}

export function locksDirectory(explodexHome: string): string {
  return join(explodexHome, "locks");
}

export function pluginsStatePath(explodexHome: string): string {
  return join(explodexHome, "state", "plugins.json");
}

export function pluginsDirectory(explodexHome: string): string {
  return join(explodexHome, "plugins");
}
