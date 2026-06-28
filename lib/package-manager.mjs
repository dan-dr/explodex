const PACKAGE_NAME = "explodex";

export function getGlobalUpdateCommand() {
  return ["npm", "install", "-g", `${PACKAGE_NAME}@latest`];
}

export function formatUpdateCommand() {
  return getGlobalUpdateCommand().join(" ");
}
