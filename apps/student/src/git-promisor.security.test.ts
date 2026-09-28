import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { projectGit } from "./git-workspace.boundary.js";
import { GitProjectEvidence } from "./git-evidence.boundary.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("missing promisor blobs fail without transport or helpers during automatic evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "marea-promisor-security-"));
  const directory = await mkdtemp(join(tmpdir(), "marea-promisor-private-"));
  roots.push(root, directory);
  await projectGit(root, ["init"]);
  await writeFile(join(root, "code.txt"), "old raw text\n");
  await projectGit(root, ["add", "code.txt"]);
  const blob = (await projectGit(root, ["hash-object", "code.txt"])).trim();
  const session = createFixtureController();
  await session.controller.start("Synthetic promisor fixture");
  const evidence = new GitProjectEvidence({
    root,
    directory,
    localSession: session.localSession,
    ids: new FixtureIds(),
  });
  await evidence.start();
  await projectGit(root, ["config", "remote.origin.url", "ssh://synthetic.invalid/no-network"]);
  await projectGit(root, ["config", "remote.origin.promisor", "true"]);
  await projectGit(root, ["config", "remote.origin.partialclonefilter", "blob:none"]);
  // Writes a local marker and exits: no SSH client/socket is launched.
  await projectGit(root, [
    "config",
    "core.sshCommand",
    "printf synthetic > lazy-fetch-marker; exit 1",
  ]);
  await projectGit(root, ["config", "protocol.ssh.allow", "always"]);
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "ssh");
  vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
  const originalEnv = { ...process.env };
  const config = await readFile(join(root, ".git/config"));
  await rm(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  await writeFile(join(root, "code.txt"), "new raw text\n");
  await expect(evidence.capture("student")).rejects.toThrow();
  await expect(readFile(join(root, "lazy-fetch-marker"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(process.env).toEqual(originalEnv);
  expect(await readFile(join(root, ".git/config"))).toEqual(config);
  // The ordinary command retains configured behavior; the helper exits without any network.
  await expect(
    promisify(execFile)("git", ["cat-file", "-p", blob], { cwd: root }),
  ).rejects.toThrow();
  expect(await readFile(join(root, "lazy-fetch-marker"), "utf8")).toBe("synthetic");
});
