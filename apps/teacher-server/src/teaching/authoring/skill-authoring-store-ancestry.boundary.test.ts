import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import { newRoot, owner, roots, saveRequest, skill } from "./authoring-test-support.fixture.js";

async function expectSerializedCreates(
  canonical: SkillAuthoringStore,
  aliased: SkillAuthoringStore,
): Promise<void> {
  await expect(
    Promise.allSettled([
      canonical.create(saveRequest("didactic", "sample", skill("sample", "First"))),
      aliased.create(saveRequest("didactic", "sample", skill("sample", "Second"))),
    ]),
  ).resolves.toMatchObject([
    { status: "fulfilled" },
    { status: "rejected", reason: { code: "SKILL_EXISTS" } },
  ]);
}

describe("SkillAuthoringStore transaction ancestry and gate identity", () => {
  it("preserves an interrupted journal when its committed kind ancestor is a link", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(saveRequest("didactic", "sample", skill("sample")));
    const transaction = join(root, ".authoring-transactions/didactic/sample");
    await mkdir(transaction, { recursive: true });
    await rename(join(root, "didactic/sample"), join(transaction, "journal"));
    await rename(join(root, "didactic"), join(root, "original-kind"));
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "preserve");
    await symlink(outside, join(root, "didactic"));
    await expect(store.recover()).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
      location: "didactic",
      message: "Use a real kind directory instead of a symbolic link.",
    });
    await expect(readFile(join(transaction, "journal/SKILL.md"), "utf8")).resolves.toBe(
      skill("sample")[0]?.content,
    );
    await expect(readdir(outside)).resolves.toEqual(["keep.txt"]);
    await expect(readFile(join(outside, "keep.txt"), "utf8")).resolves.toBe("preserve");
    expect(original.description).toBe("Practice testing");
  });

  it("fails every public operation closed when the transaction root is a symbolic link", async () => {
    const synthetic = await mkdtemp(join(tmpdir(), "marea-tx-root-link-"));
    roots.push(synthetic);
    const outside = join(synthetic, "outside");
    await mkdir(join(outside, "didactic", "sample", "didactic"), { recursive: true });
    const sentinel = join(outside, "didactic", "sample", "didactic", "keep.txt");
    await writeFile(sentinel, "untouched bytes");
    const ownerRoot = join(synthetic, "owner-root");
    await new SkillAuthoringStore(ownerRoot, owner).initialize();
    await symlink(outside, join(ownerRoot, ".authoring-transactions"));
    const store = new SkillAuthoringStore(ownerRoot, owner);
    const linkRejection = {
      code: "AUTHORING_RECOVERY_FAILED",
      message: "Use a real transaction root directory instead of a symbolic link.",
    };
    await expect(store.recover()).rejects.toMatchObject(linkRejection);
    await expect(store.list("didactic")).rejects.toMatchObject(linkRejection);
    await expect(store.read("teacher/owner-1/sample")).rejects.toMatchObject(linkRejection);
    await expect(store.validate("didactic", "sample", skill("sample"))).rejects.toMatchObject(
      linkRejection,
    );
    await expect(
      store.create(saveRequest("didactic", "sample", skill("sample"))),
    ).rejects.toMatchObject(linkRejection);
    await expect(
      store.replace(saveRequest("didactic", "sample", skill("sample"))),
    ).rejects.toMatchObject(linkRejection);
    await expect(store.initialize()).rejects.toMatchObject(linkRejection);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("untouched bytes");
  });

  it("fails every public operation closed when the transaction root is not a directory", async () => {
    const root = await newRoot();
    const outside = join(root, "outside-sentinel");
    await writeFile(outside, "sentinel bytes");
    await writeFile(join(root, ".authoring-transactions"), "not-a-directory");
    const store = new SkillAuthoringStore(root, owner);
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      message: "Inspect the transaction root; it must be a real directory.",
    });
    await expect(store.list("didactic")).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      message: "Inspect the transaction root; it must be a real directory.",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("sentinel bytes");
    await expect(readFile(join(root, ".authoring-transactions"), "utf8")).resolves.toBe(
      "not-a-directory",
    );
  });

  it("shares the owner gate through canonical ancestor aliases and rejects direct root links", async () => {
    const synthetic = await mkdtemp(join(tmpdir(), "marea-canonical-"));
    roots.push(synthetic);
    const realRoot = join(synthetic, "real", "root");
    await mkdir(realRoot, { recursive: true });
    await symlink(join(synthetic, "real"), join(synthetic, "alias"));
    const canonical = new SkillAuthoringStore(realRoot, owner);
    const aliased = new SkillAuthoringStore(join(synthetic, "alias", "root"), owner);
    await canonical.initialize();
    await expectSerializedCreates(canonical, aliased);
    const linked = join(synthetic, "real", "linked-root");
    await symlink(realRoot, linked);
    await expect(new SkillAuthoringStore(linked, owner).list("didactic")).rejects.toMatchObject({
      code: "ROOT_NOT_EXCLUSIVE",
    });
  });

  it("shares the gate when stores are constructed before their aliased root exists", async () => {
    const synthetic = await mkdtemp(join(tmpdir(), "marea-missing-canonical-"));
    roots.push(synthetic);
    await mkdir(join(synthetic, "real"));
    await symlink(join(synthetic, "real"), join(synthetic, "alias"));
    const canonical = new SkillAuthoringStore(join(synthetic, "real/nested/root"), owner);
    const aliased = new SkillAuthoringStore(join(synthetic, "alias/nested/root"), owner);
    await canonical.initialize();
    await expectSerializedCreates(canonical, aliased);
    await expect(aliased.read("teacher/owner-1/sample")).resolves.toMatchObject({
      description: "First",
    });
  });
});
