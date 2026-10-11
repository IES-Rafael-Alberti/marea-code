import { expect, it } from "vitest";
import { workspaceFixture } from "./workspace.fixture.js";

it("requires an editable detail, reviewed destinations and explicit confirmation before deletion", async () => {
  const f = workspaceFixture(),
    c = f.controller;
  expect(c.deleting).toBe(false);
  await c.reviewDeletion();
  expect(c.problem).toBeNull();
  await c.deleteSkill();
  expect(c.problem).toBeNull();
  expect(f.request).not.toHaveBeenCalled();
  await c.open(f.bundle.id);
  const original = c.detail;
  if (!original) throw new Error("detail");
  for (const detail of [null, { ...original, editable: false }, { ...original, skill: null }]) {
    c.detail = detail;
    c.deleting = true;
    f.request.mockClear();
    await c.reviewDeletion();
    expect(c.problem).toBeNull();
    await c.deleteSkill();
    expect(c.problem).toBeNull();
    expect(f.request).not.toHaveBeenCalled();
  }
  c.detail = original;
  c.usage = null;
  await c.deleteSkill();
  expect(f.request).not.toHaveBeenCalled();
  c.deleting = false;
  await c.deleteSkill();
  expect(f.request).not.toHaveBeenCalled();
  await c.reviewDeletion();
  expect(c.deleting).toBe(true);
  f.failures.set("delete", 409);
  await c.deleteSkill();
  expect(c.problem).toBe("conflict");
  expect(c.detail).toEqual(original);
  expect(c.deleting).toBe(true);
  c.copyEditor();
  c.create("didactic");
  const editor = c.editor;
  c.busy = true;
  c.copyEditor();
  expect(c.editor).toBe(editor);
});
it("retains conflict copies and redraws proposal changes without accepting a missing or foreign-identity proposal", () => {
  const f = workspaceFixture(),
    c = f.controller;
  c.create("didactic");
  const original = c.editor;
  c.problem = "conflict";
  c.generated = "old";
  f.changed.mockClear();
  c.copyEditor();
  expect(c.editor).toMatchObject({
    expectedDigest: null,
    skillId: null,
    usage: null,
    applyPending: false,
  });
  expect(c.editor?.key).toBe(`copy:${c.editor?.draft.slug ?? "missing"}`);
  expect(c.drafts.get(c.editor?.key ?? "")).toBe(c.editor);
  expect(c.editor).not.toBe(original);
  expect(c.generated).toBeNull();
  expect(c.problem).toBeNull();
  expect(f.changed).toHaveBeenCalledOnce();
  const copied = c.editor;
  f.changed.mockClear();
  c.acceptGenerated();
  expect(c.editor).toBe(copied);
  expect(f.changed).not.toHaveBeenCalled();
  c.generated = "---\nname: foreign\ndescription: Example\n---\nBody";
  c.acceptGenerated();
  expect(c.editor?.draft.slug).toBe(copied?.draft.slug);
  expect(c.generated).toBeNull();
  c.generated = "discard";
  f.changed.mockClear();
  c.discardGenerated();
  expect(c.generated).toBeNull();
  expect(f.changed).toHaveBeenCalledOnce();
  c.deleting = true;
  f.changed.mockClear();
  c.cancelDeletion();
  expect(c.deleting).toBe(false);
  expect(f.changed).toHaveBeenCalledOnce();
});
