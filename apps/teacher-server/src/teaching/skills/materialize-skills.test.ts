import { Sha256DigestSchema, SkillIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { materializeTeachingSkills, type TeachingSkillSelection } from "./materialize-skills.js";
import { digestSkillFiles } from "./skill-digest.js";
import type { SkillBundle, SkillSource } from "./skill-source.js";

function bundle(kind: SkillBundle["kind"] = "didactic"): SkillBundle {
  const files = [{ path: "SKILL.md", content: "Teach.\n", sizeBytes: 7 }];
  return {
    id: SkillIdSchema.parse(`marea/${kind}`),
    name: kind,
    description: "Description",
    kind,
    source: "marea",
    digest: digestSkillFiles(files),
    license: null,
    compatibility: null,
    criteria:
      kind === "evaluation"
        ? []
        : [
            { code: "C1", statement: "Explain", levels: ["One", "Two", "Three", "Four"] },
            { code: "C2", statement: "Reflect", levels: null },
          ],
    files,
  };
}

function fixture() {
  const didactic = bundle();
  const evaluation = bundle("evaluation");
  const load = vi.fn<SkillSource["load"]>((id) =>
    Promise.resolve(id === didactic.id ? didactic : evaluation),
  );
  const source = { list: vi.fn<SkillSource["list"]>(), load };
  const selection: TeachingSkillSelection = {
    agentMode: "tutoring",
    didactic: [{ id: didactic.id, digest: didactic.digest }],
    evaluation: [{ id: evaluation.id, digest: evaluation.digest }],
  };
  return { didactic, evaluation, load, source, selection };
}

describe("materializeTeachingSkills", () => {
  it("captures all bytes and metadata in independently frozen public/private collections", async () => {
    const { didactic, evaluation, source, selection } = fixture();
    const snapshot = await materializeTeachingSkills(source, selection);
    expect(snapshot).toEqual({ didactic: [didactic], evaluation: [evaluation] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    for (const kind of ["didactic", "evaluation"] as const) {
      expect(Object.isFrozen(snapshot[kind])).toBe(true);
      const captured = snapshot[kind][0];
      expect(captured).not.toBe(kind === "didactic" ? didactic : evaluation);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured?.files)).toBe(true);
      expect(Object.isFrozen(captured?.files[0])).toBe(true);
      expect(Object.isFrozen(captured?.criteria)).toBe(true);
      expect(Object.isFrozen(captured?.criteria[0])).toBe(true);
      expect(Object.isFrozen(captured?.criteria[0]?.levels)).toBe(true);
    }
    Object.assign(didactic.files[0] ?? {}, { content: "Replaced" });
    Object.assign(didactic.criteria[0] ?? {}, { statement: "Replaced" });
    Object.assign(didactic.criteria[0]?.levels ?? [], { 0: "Replaced" });
    expect(snapshot.didactic[0]?.files[0]?.content).toBe("Teach.\n");
    expect(snapshot.didactic[0]?.criteria[0]).toEqual({
      code: "C1",
      statement: "Explain",
      levels: ["One", "Two", "Three", "Four"],
    });
  });

  it("omits didactic material in free mode but retains private evaluation inputs", async () => {
    const { evaluation, source, selection, load } = fixture();
    const snapshot = await materializeTeachingSkills(source, { ...selection, agentMode: "free" });
    expect(snapshot).toEqual({ didactic: [], evaluation: [evaluation] });
    expect(load.mock.calls).toEqual([[evaluation.id]]);
  });

  it("supports empty selections", async () => {
    const { source, load } = fixture();
    expect(
      await materializeTeachingSkills(source, {
        agentMode: "tutoring",
        didactic: [],
        evaluation: [],
      }),
    ).toEqual({ didactic: [], evaluation: [] });
    expect(load).not.toHaveBeenCalled();
  });

  it("copies both selections before yielding to an asynchronous source", async () => {
    const { didactic, evaluation, source, selection, load } = fixture();
    const mutableDidactic = { id: didactic.id, digest: didactic.digest };
    const mutableEvaluation = { id: evaluation.id, digest: evaluation.digest };
    const inputs = { ...selection, didactic: [mutableDidactic], evaluation: [mutableEvaluation] };
    load.mockImplementationOnce(() => {
      mutableDidactic.id = SkillIdSchema.parse("marea/replaced");
      mutableEvaluation.id = SkillIdSchema.parse("marea/replaced");
      inputs.didactic.splice(0);
      inputs.evaluation.splice(0);
      return Promise.resolve(didactic);
    });
    expect(await materializeTeachingSkills(source, inputs)).toEqual({
      didactic: [didactic],
      evaluation: [evaluation],
    });
  });

  it("rejects duplicate selection identities before loading", async () => {
    const { source, selection, didactic, load } = fixture();
    await expect(
      materializeTeachingSkills(source, {
        ...selection,
        evaluation: selection.didactic,
      }),
    ).rejects.toMatchObject({
      name: "SkillSnapshotError",
      skillId: didactic.id,
      reason: "duplicate",
      message: "Cannot capture skill marea/didactic: duplicate.",
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects a deleted selected revision", async () => {
    const { source, selection, load } = fixture();
    load.mockResolvedValueOnce(null);
    await expect(materializeTeachingSkills(source, selection)).rejects.toMatchObject({
      skillId: "marea/didactic",
      reason: "missing",
    });
  });

  it.each(["id", "kind", "digest", "files"] as const)("rejects changed %s", async (field) => {
    const { source, selection, load, didactic } = fixture();
    const alterations = {
      id: SkillIdSchema.parse("marea/other"),
      kind: "evaluation" as const,
      digest: Sha256DigestSchema.parse(`sha256:${"0".repeat(64)}`),
      files: [{ path: "SKILL.md", content: "Other.\n", sizeBytes: 7 }],
    };
    load.mockResolvedValueOnce({ ...didactic, [field]: alterations[field] });
    await expect(materializeTeachingSkills(source, selection)).rejects.toMatchObject({
      skillId: didactic.id,
      reason: "changed",
    });
  });

  it("propagates failure without returning a partial snapshot", async () => {
    const { source, selection, load, didactic } = fixture();
    load.mockResolvedValueOnce(didactic).mockRejectedValueOnce(new Error("Unavailable"));
    await expect(materializeTeachingSkills(source, selection)).rejects.toThrow("Unavailable");
  });
});
