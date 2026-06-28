export function decideLaunchState({ portListening, portOwnedByCodex, codexRunning }) {
  if (portListening && portOwnedByCodex) return "debug-codex";
  if (portListening) return "foreign-port";
  if (codexRunning) return "plain-codex";
  return "stopped";
}

export function getPlatformAdapter(platform = process.platform) {
  if (platform === "darwin") return import("./platform/macos.mjs");
  throw new Error(`${platform} is not supported. Explodex currently supports macOS only.`);
}
