import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathExists } from "./paths.mjs";

export const PLUGIN_CREATOR_SKILL = "explodex-plugin-builder";
export const SKILL_INSTALL_COMMAND = ["npx", "skills", "add", "dan-dr/explodex"];

export function getPluginCreatorSkillPaths(home = homedir()) {
  return [
    join(home, ".agents", "skills", PLUGIN_CREATOR_SKILL, "SKILL.md"),
    join(home, ".codex", "skills", PLUGIN_CREATOR_SKILL, "SKILL.md"),
    join(home, ".claude", "skills", PLUGIN_CREATOR_SKILL, "SKILL.md"),
  ];
}

export async function isPluginCreatorSkillInstalled(home = homedir()) {
  const checks = await Promise.all(getPluginCreatorSkillPaths(home).map(pathExists));
  return checks.some(Boolean);
}

export async function installPluginCreatorSkill({ spawnImpl = spawn } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl(SKILL_INSTALL_COMMAND[0], SKILL_INSTALL_COMMAND.slice(1), {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${SKILL_INSTALL_COMMAND[0]} terminated by ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${SKILL_INSTALL_COMMAND.join(" ")} exited with code ${code}`));
    });
  });
}
