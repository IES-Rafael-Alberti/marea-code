import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectGit } from "./git-workspace.boundary.js";
import { describeProject } from "./project-description.boundary.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("automatic status avoids nested filters while preserving gitlink changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marea-submodule-security-"));
  roots.push(root);
  const nested = join(root, "nested");
  await mkdir(nested);
  await projectGit(root, ["init"]);
  await projectGit(nested, ["init"]);
  await writeFile(join(nested, "code.txt"), "old text\n");
  await writeFile(join(nested, ".gitattributes"), "*.txt filter=submodule-only\n");
  await projectGit(nested, ["add", "."]);
  await projectGit(nested, [
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-m",
    "Synthetic",
  ]);
  await writeFile(
    join(root, ".gitmodules"),
    '[submodule "nested"]\n path = nested\n url = ./nested\n',
  );
  await projectGit(root, ["add", "."]);
  await projectGit(nested, [
    "config",
    "filter.submodule-only.clean",
    "printf synthetic > submodule-marker; cat",
  ]);
  await writeFile(join(nested, "code.txt"), "new text\n");
  await describeProject(root);
  await expect(readFile(join(nested, "submodule-marker"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await promisify(execFile)("git", ["status", "--porcelain=v1"], { cwd: root });
  expect(await readFile(join(nested, "submodule-marker"), "utf8")).toBe("synthetic");
  await rm(join(nested, "submodule-marker"));
  await projectGit(nested, ["add", "code.txt"]);
  await expect(readFile(join(nested, "submodule-marker"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await projectGit(nested, [
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-m",
    "Next synthetic",
  ]);
  const next = (await projectGit(nested, ["rev-parse", "HEAD"])).trim();
  // Fixture commits are ordinary Git operations and may refresh through the filter.
  // Start a fresh observation window for Marea's automatic status and diff below.
  await rm(join(nested, "submodule-marker"), { force: true });
  await projectGit(root, ["config", "diff.submodule", "diff"]);
  const status = await projectGit(root, ["status", "--porcelain=v1"]);
  expect(status).toContain("AM nested");
  const patch = await projectGit(root, ["diff", "--no-ext-diff", "--no-textconv"]);
  expect(patch).toContain(`+Subproject commit ${next}`);
  expect(patch).not.toContain("new text");
  await expect(readFile(join(nested, "submodule-marker"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
