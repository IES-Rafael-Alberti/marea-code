import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillIdSchema } from "@marea/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  BundledSkillSource,
  CompositeSkillSource,
  DirectorySkillSource,
  materializeTeachingSkills,
  type SkillDirectoryOwner,
  type SkillKind,
  type SkillSource,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function catalogRoot(kind: SkillKind = "didactic"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marea-scoped-skills-"));
  roots.push(root);
  await mkdir(join(root, "didactic"));
  await mkdir(join(root, "evaluation"));
  await mkdir(join(root, kind, "testing", "resources"), { recursive: true });
  await writeFile(
    join(root, kind, "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Practice testing\n---\n\nTeach testing.\n",
  );
  await writeFile(join(root, kind, "testing", "resources", "guide.txt"), "Read this guide.\n");
  return root;
}

describe("DirectorySkillSource", () => {
  it.each(["teacher", "center"] as const)(
    "retains content with explicit %s ownership",
    async (source) => {
      const root = await catalogRoot();
      const directory = new DirectorySkillSource(root, { source, id: "owner-1" });
      const id = SkillIdSchema.parse(`${source}/owner-1/testing`);
      const bundle = await directory.load(id);
      const core = await new BundledSkillSource(root).load(SkillIdSchema.parse("marea/testing"));

      expect(bundle).toEqual({ ...core, id, source });
      expect(Object.isFrozen(bundle)).toBe(true);
      expect(Object.isFrozen(bundle?.files)).toBe(true);
      const summaries = await directory.list("didactic");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ id, source, digest: bundle?.digest });
      expect(summaries[0]).not.toHaveProperty("files");
      expect(Object.isFrozen(summaries)).toBe(true);
      expect(Object.isFrozen(summaries[0])).toBe(true);
      expect(await directory.list("evaluation")).toEqual([]);
    },
  );

  it("does not resolve another namespace or owner, including owner-prefix collisions", async () => {
    const directory = new DirectorySkillSource("/unreadable-unused-source", {
      source: "teacher",
      id: "one",
    });
    for (const id of ["marea/testing", "center/one/testing", "teacher/one-more/testing"]) {
      expect(await directory.load(SkillIdSchema.parse(id))).toBeNull();
    }
  });

  it("returns null for a missing owned skill and lists evaluation separately", async () => {
    const directory = new DirectorySkillSource(await catalogRoot("evaluation"), {
      source: "center",
      id: "c1",
    });
    expect(await directory.load(SkillIdSchema.parse("center/c1/missing"))).toBeNull();
    expect(await directory.list("didactic")).toEqual([]);
    expect((await directory.list("evaluation")).map((skill) => skill.id)).toEqual([
      "center/c1/testing",
    ]);
  });

  it.each(["", "..", "a/b", "a\\b", "a ", "a/../b"])("rejects unsafe owner %j before I/O", (id) => {
    expect(() => new DirectorySkillSource("/unused", { source: "teacher", id })).toThrow();
  });

  it("copies owner configuration and never changes already loaded content", async () => {
    const root = await catalogRoot();
    const owner: { source: SkillDirectoryOwner["source"]; id: string } = {
      source: "teacher",
      id: "t1",
    };
    const directory = new DirectorySkillSource(root, owner);
    owner.source = "center";
    owner.id = "changed";
    const id = SkillIdSchema.parse("teacher/t1/testing");
    const before = await directory.load(id);
    await writeFile(join(root, "didactic", "testing", "resources", "guide.txt"), "Changed.");
    const after = await directory.load(id);
    expect(before?.source).toBe("teacher");
    expect(before?.files[1]?.content).toBe("Read this guide.\n");
    expect(after?.files[1]?.content).toBe("Changed.");
    expect(after?.digest).not.toBe(before?.digest);
  });

  it("inherits strict filesystem containment and rejects symlinked resources", async () => {
    const root = await catalogRoot();
    await symlink(
      join(root, "didactic", "testing", "SKILL.md"),
      join(root, "didactic", "testing", "resources", "link.md"),
    );
    const directory = new DirectorySkillSource(root, { source: "teacher", id: "t1" });
    await expect(directory.list("didactic")).rejects.toMatchObject({ code: "UNSAFE_SYMLINK" });
  });
});

describe("CompositeSkillSource", () => {
  it("keeps a complete materialized capture after both on-disk sources are deleted", async () => {
    const didacticRoot = await catalogRoot();
    const evaluationRoot = await catalogRoot("evaluation");
    const source = new CompositeSkillSource([
      new DirectorySkillSource(didacticRoot, { source: "teacher", id: "t1" }),
      new DirectorySkillSource(evaluationRoot, { source: "center", id: "c1" }),
    ]);
    const selection = {
      agentMode: "tutoring" as const,
      didactic: await source.list("didactic"),
      evaluation: await source.list("evaluation"),
    };
    const capture = await materializeTeachingSkills(source, selection);
    const beforeDeletion = JSON.stringify(capture);
    await rm(didacticRoot, { recursive: true });
    await rm(evaluationRoot, { recursive: true });
    expect(JSON.stringify(capture)).toBe(beforeDeletion);
    expect(capture.didactic[0]?.files).toEqual([
      {
        path: "SKILL.md",
        content: "---\nname: testing\ndescription: Practice testing\n---\n\nTeach testing.\n",
        sizeBytes: 68,
      },
      { path: "resources/guide.txt", content: "Read this guide.\n", sizeBytes: 17 },
    ]);
    expect(capture.evaluation[0]?.id).toBe("center/c1/testing");
    expect(capture.didactic[0]?.digest).toBe(selection.didactic[0]?.digest);
    await expect(materializeTeachingSkills(source, selection)).rejects.toMatchObject({
      code: "READ_FAILED",
    });
  });

  it("keeps equal slugs distinct, sorts independently of source order and copies its sources", async () => {
    const root = await catalogRoot();
    const teacher = new DirectorySkillSource(root, { source: "teacher", id: "t1" });
    const core = new BundledSkillSource(root);
    const center = new DirectorySkillSource(root, { source: "center", id: "c1" });
    const inputs: SkillSource[] = [teacher, core, center];
    const combined = new CompositeSkillSource(inputs);
    inputs.splice(0);
    const summaries = await combined.list("didactic");
    expect(summaries.map((skill) => skill.id)).toEqual([
      "center/c1/testing",
      "marea/testing",
      "teacher/t1/testing",
    ]);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(await combined.list("evaluation")).toEqual([]);
    expect(await new CompositeSkillSource([center, core, teacher]).list("didactic")).toEqual(
      summaries,
    );
    for (const source of [teacher, center, core]) {
      const [summary] = await source.list("didactic");
      if (summary === undefined) throw new Error("Fixture skill missing.");
      expect(await combined.load(summary.id)).toEqual(await source.load(summary.id));
    }
    expect(await combined.load(SkillIdSchema.parse("teacher/other/testing"))).toBeNull();
  });

  it("supports an empty catalog", async () => {
    const source = new CompositeSkillSource([]);
    expect(await source.list("didactic")).toEqual([]);
    expect(await source.load(SkillIdSchema.parse("marea/testing"))).toBeNull();
  });

  it("rejects duplicates even when their content is identical", async () => {
    const core = new BundledSkillSource(await catalogRoot());
    const source = new CompositeSkillSource([core, core]);
    for (const operation of [
      () => source.list("didactic"),
      () => source.load(SkillIdSchema.parse("marea/testing")),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: "BundledSkillError",
        code: "DUPLICATE_SKILL_ID",
        location: "marea/testing",
        message:
          "Skill marea/testing appears in more than one catalog entry; select distinct source identities.",
      });
    }
  });

  it("rejects collisions across kinds, even when listing the other kind", async () => {
    const source = new CompositeSkillSource([
      new BundledSkillSource(await catalogRoot()),
      new BundledSkillSource(await catalogRoot("evaluation")),
    ]);
    await expect(source.list("evaluation")).rejects.toMatchObject({ code: "DUPLICATE_SKILL_ID" });
  });

  it("does not hide a source failure behind a successful earlier match", async () => {
    const source = new CompositeSkillSource([
      new BundledSkillSource(await catalogRoot()),
      new BundledSkillSource("/missing-marea-skill-source"),
    ]);
    await expect(source.list("didactic")).rejects.toMatchObject({ code: "READ_FAILED" });
    await expect(source.load(SkillIdSchema.parse("marea/testing"))).rejects.toMatchObject({
      code: "READ_FAILED",
    });
  });
});
