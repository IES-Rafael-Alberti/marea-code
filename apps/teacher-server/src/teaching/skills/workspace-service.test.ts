import { expect, it, vi } from "vitest";
import { skillAssignmentFixture } from "../../platform/persistence/skill-assignments.fixture.js";
import { MemorySkillSource, syntheticSkill } from "../configuration/dashboard-module.fixture.js";

it("reads human titles and falls back when a catalog entry disappears or lacks a usable title", async () => {
  const f = skillAssignmentFixture();
  const source = new MemorySkillSource([
    syntheticSkill("didactic", "alpha"),
    syntheticSkill("didactic", "beta"),
  ]);
  f.setSource(source);
  for (const content of [
    "---\nmetadata:\n  title: ' Human title '\n---\n",
    "---\nmetadata:\n  title: '   '\n---\n",
    "---\nmetadata:\n  title: 42\n---\n",
    "no yaml",
  ]) {
    const template = syntheticSkill("didactic", "alpha");
    vi.spyOn(source, "load").mockResolvedValue({
      ...template,
      files: [{ path: "SKILL.md", content, sizeBytes: content.length }],
    });
    const page = await f.service.execute(f.teacher, f.request({ kind: "library", after: null }));
    if (page.kind !== "library") throw new Error("library");
    expect(page.skills[0]?.title).toBe(content.includes("Human title") ? "Human title" : "alpha");
  }
  vi.spyOn(source, "load").mockResolvedValue(null);
  expect(
    await f.service.execute(f.teacher, f.request({ kind: "library", after: null })),
  ).toMatchObject({ skills: [{ title: "alpha" }, { title: "beta" }] });
  vi.spyOn(source, "load").mockResolvedValue({ ...syntheticSkill("didactic", "alpha"), files: [] });
  expect(
    await f.service.execute(f.teacher, f.request({ kind: "library", after: null })),
  ).toMatchObject({ skills: [{ title: "alpha" }, { title: "beta" }] });
  vi.restoreAllMocks();
});

it("uses only anchored main-file metadata and bounds long titles without corrupting fallback names", async () => {
  const f = skillAssignmentFixture();
  const template = syntheticSkill("didactic", "unit-testing");
  const source = new MemorySkillSource([template]);
  f.setSource(source);
  for (const [content, title] of [
    ["prefix\n---\nmetadata:\n  title: Wrong\n---\n", "unit testing"],
    [`---\r\nmetadata:\r\n  title: '${"t".repeat(257)}'\r\n---\r\n`, "t".repeat(256)],
  ] as const) {
    vi.spyOn(source, "load").mockResolvedValue({
      ...template,
      files: [
        {
          path: "resources/example.md",
          content: "---\nmetadata:\n  title: Resource\n---\n",
          sizeBytes: 42,
        },
        { path: "SKILL.md", content, sizeBytes: content.length },
      ],
    });
    expect(
      await f.service.execute(f.teacher, f.request({ kind: "library", after: null })),
    ).toMatchObject({ skills: [{ title }] });
  }
  vi.restoreAllMocks();
});

it("rejects applying another owner's bundle, a stale digest or a deleted skill with a stable domain error", async () => {
  const f = skillAssignmentFixture();
  const own = syntheticSkill("didactic", "own");
  const foreign = { ...own, id: "teacher/t2/own" as typeof own.id };
  const source = new MemorySkillSource([own, foreign]);
  f.setSource(source);
  const usage = f.assignments.usage("t1", own.id).version;
  await expect(
    f.service.execute(
      f.teacher,
      f.request({
        kind: "apply",
        skillId: foreign.id,
        digest: foreign.digest,
        expectedUsage: usage,
      }),
    ),
  ).rejects.toMatchObject({ code: "dashboard.forbidden" });
  for (const [skillId, digest] of [
    [own.id, `sha256:${"0".repeat(64)}`],
    ["teacher/t1/missing", own.digest],
  ])
    await expect(
      f.service.execute(
        f.teacher,
        f.request({ kind: "apply", skillId, digest, expectedUsage: usage }),
      ),
    ).rejects.toMatchObject({ code: "request.conflict" });
});
