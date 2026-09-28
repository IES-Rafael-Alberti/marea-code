import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFileStudentStores } from "./filesystem.boundary.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(): Promise<{ root: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "marea-state-containment-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  return { root, projectRoot };
}
it("rejects project descendants beginning with two dots before creating state", async () => {
  const { projectRoot } = await fixture();
  for (const name of ["..state", "..credentials", "..agent-state/nested"]) {
    const stateDirectory = join(projectRoot, name);
    await expect(createFileStudentStores({ projectRoot, stateDirectory })).rejects.toThrow(
      "outside the project",
    );
    await expect(lstat(stateDirectory)).rejects.toThrow();
  }
});
it("also rejects a symlink-resolved two-dot descendant without changing its permissions", async () => {
  const { root, projectRoot } = await fixture();
  const target = join(projectRoot, "..state");
  await mkdir(target, { mode: 0o755 });
  const before = (await lstat(target)).mode;
  const alias = join(root, "alias");
  await symlink(target, alias);
  await expect(createFileStudentStores({ projectRoot, stateDirectory: alias })).rejects.toThrow(
    "outside the project",
  );
  expect((await lstat(target)).mode).toBe(before);
});
it("permits an actual parent directory and an external dot-prefixed sibling", async () => {
  const { root, projectRoot } = await fixture();
  await expect(
    createFileStudentStores({ projectRoot, stateDirectory: root }),
  ).resolves.toHaveProperty("credentials");
  await expect(
    createFileStudentStores({ projectRoot, stateDirectory: join(root, "..state") }),
  ).resolves.toHaveProperty("state");
});
