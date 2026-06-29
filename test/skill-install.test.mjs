import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getPluginCreatorSkillPaths,
  installPluginCreatorSkill,
  isPluginCreatorSkillInstalled,
  SKILL_INSTALL_COMMAND,
} from "../lib/skill-install.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("plugin creator skill install", () => {
  test("detects the canonical skill in supported agent homes", async () => {
    const home = await mkdtemp(join(tmpdir(), "explodex-skill-"));
    roots.push(home);
    expect(await isPluginCreatorSkillInstalled(home)).toBe(false);
    const skillPath = getPluginCreatorSkillPaths(home)[0];
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "---\nname: explodex-plugin-builder\n---\n");
    expect(await isPluginCreatorSkillInstalled(home)).toBe(true);
  });

  test("runs the documented skills command", async () => {
    let invocation;
    await installPluginCreatorSkill({
      spawnImpl: (file, args, options) => {
        invocation = { file, args, options };
        return {
          once(event, callback) {
            if (event === "exit") queueMicrotask(() => callback(0, null));
            return this;
          },
        };
      },
    });
    expect([invocation.file, ...invocation.args]).toEqual(SKILL_INSTALL_COMMAND);
    expect(invocation.options.stdio).toBe("inherit");
  });
});
