import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });

test("install-launcher works in a temporary HOME", async () => {
  home = await mkdtemp(join(tmpdir(), "explodex-home-"));
  const root = join(import.meta.dir, "..");
  const linkedBin = join(home, "explodex");
  await symlink(join(root, "bin", "explodex.mjs"), linkedBin);
  const proc = Bun.spawn(["node", linkedBin, "install-launcher"], { cwd: root, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  const launcher = await readFile(join(home, "Applications", "Explodex.app", "Contents", "MacOS", "Explodex"), "utf8");
  expect(launcher).toContain("/bin/zsh -lic 'exec explodex --from-app'");
});
