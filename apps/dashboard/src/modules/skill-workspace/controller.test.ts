import { expect, it, vi } from "vitest";
import { workspaceFixture } from "./workspace.fixture.js";
import { editSkillFields, skillEditorFields } from "./draft.boundary.js";

it("loads the library and roster, assigns a personal empty selection and restores inheritance", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  expect(c.loaded).toBe(true);
  expect(c.catalog[0]?.title).toBe("Unit testing");
  expect(c.students).toHaveLength(2);
  await c.assignStudents(["s1", "s2"], []);
  expect(c.students.map((item) => item.selection)).toEqual([[], []]);
  await c.assignStudents(["s1"], null);
  expect(c.students.map((item) => item.selection)).toEqual([null, []]);
  expect(c.notice).toBe("assigned");
});

it("keeps class settings intact while changing selected skills and refreshes the shared tutor editor", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  const before = c.configuration?.settings;
  const selection = [{ id: f.bundle.id, digest: f.bundle.digest }];
  await c.assignClass(selection);
  expect(c.configuration?.settings).toEqual({
    ...before,
    selection: { didactic: selection, evaluation: [] },
  });
  expect(f.teachingChanged).toHaveBeenCalledOnce();
  await c.assignClass([], "evaluation");
  expect(c.configuration?.settings.automaticEvaluation).toBe(false);
});

it("keeps drafts when closing and reopening the editor, and applies edits without reselecting the skill", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  await c.open(f.bundle.id);
  c.editDetail();
  const draft = c.editor?.draft;
  if (!draft) throw new Error("editor");
  c.edit(editSkillFields(draft, { instructions: "Practice boundary cases." }));
  c.closeEditor();
  c.closeDetail();
  await c.open(f.bundle.id);
  c.editDetail();
  expect(skillEditorFields(c.editor?.draft ?? draft)?.instructions).toBe(
    "Practice boundary cases.",
  );
  await c.save();
  expect(c.problem).toBeNull();
  expect(c.notice).toBe("saved");
  expect(c.editor).toBeNull();
  expect(c.drafts.size).toBe(0);
  expect(
    f.request.mock.calls
      .map(([, init]) => (typeof init.body === "string" ? init.body : ""))
      .some((body) => body.includes('"kind":"apply"')),
  ).toBe(true);
});

it("preserves a saved but unapplied revision and retries only the assignment step after review", async () => {
  const f = await pendingSave();
  const c = f.controller;
  expect(c.problem).toBe("apply");
  expect(c.editor?.applyPending).toBe(true);
  const before = f.request.mock.calls.filter(([, init]) =>
    (typeof init.body === "string" ? init.body : "").includes('"kind":"skill-authoring-save"'),
  ).length;
  f.failures.delete("apply");
  await c.reviewApplication();
  await c.apply();
  expect(c.notice).toBe("saved");
  expect(c.drafts.size).toBe(0);
  expect(
    f.request.mock.calls.filter(([, init]) =>
      (typeof init.body === "string" ? init.body : "").includes('"kind":"skill-authoring-save"'),
    ),
  ).toHaveLength(before);
});

it("creates or copies a draft with a generated identifier and never changes the source", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  c.create("didactic");
  const original = c.editor?.draft;
  if (!original) throw new Error("editor");
  c.edit(
    editSkillFields(original, {
      title: "My skill",
      description: "Practice",
      instructions: "Start small.",
    }),
  );
  c.closeEditor();
  c.create("didactic");
  expect(skillEditorFields(c.editor?.draft ?? original)?.title).toBe("My skill");
  c.discardEditor();
  expect(c.drafts.size).toBe(0);
  await c.load();
  await c.open(f.bundle.id);
  c.editDetail(true);
  expect(c.editor?.draft.slug).not.toBe("testing");
  expect(c.editor?.expectedDigest).toBeNull();
  await c.save();
  expect(c.notice).toBe("saved");
});

it("does not double-submit and preserves work when a save is rejected", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  await c.open(f.bundle.id);
  c.editDetail();
  const editor = c.editor;
  f.failures.set("skill-authoring-save", 409);
  await Promise.all([c.save(), c.save()]);
  expect(c.editor).toBe(editor);
  expect(c.problem).not.toBeNull();
  c.dispose();
  const calls = f.request.mock.calls.length;
  await c.load();
  expect(f.request).toHaveBeenCalledTimes(calls);
});

it("keeps a saved identity recoverable if fetching its destinations fails", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  c.create("didactic");
  if (!c.editor) throw new Error("editor");
  c.edit(
    editSkillFields(c.editor.draft, {
      title: "New",
      description: "Practice",
      instructions: "Try.",
    }),
  );
  f.failures.set("usage", 503);
  await c.save();
  expect(c.problem).toBe("apply");
  expect(c.editor.expectedDigest).toBe(f.bundle.digest);
  expect(c.editor.usage).toBeNull();
  const saved = c.editor;
  await c.apply();
  expect(c.editor).toBe(saved);
  expect(c.drafts.get(saved.key)).toBe(saved);
  f.failures.delete("usage");
  await c.reviewApplication();
  await c.apply();
  expect(c.notice).toBe("saved");
});

it("rejects invalid actions without losing a draft or changing class configuration", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  c.editDetail();
  c.discardEditor();
  await c.save();
  await c.apply();
  await c.reviewApplication();
  await c.assignClass([]);
  expect(c.problem).toBe("unavailable");
  await c.assignStudents(["s1"], []);
  expect(c.problem).toBe("unavailable");
  c.create("didactic");
  if (!c.editor) throw new Error("editor");
  const draft = c.editor.draft;
  c.closeEditor();
  c.edit(draft);
  expect(c.editor).toBeNull();
  c.create("didactic");
  const original = c.editor;
  c.busy = true;
  c.edit(editSkillFields(draft, { title: "Ignored" }));
  expect(c.editor).toBe(original);
  c.busy = false;
  c.editor = { ...original, applyPending: true };
  const pending = c.editor;
  c.edit(draft);
  expect(c.editor).toBe(pending);
  await c.reviewApplication();
  expect(c.editor).toBe(pending);
  c.discardEditor();
  await c.load();
  await c.assignStudents(["missing"], []);
  expect(c.problem).toBe("unavailable");
  await c.open(f.bundle.id);
  if (!c.detail) throw new Error("detail");
  c.detail = { ...c.detail, editable: false };
  c.editDetail();
  expect(c.editor).toBeNull();
  c.detail = { ...c.detail, skill: null, editable: true };
  c.editDetail();
  expect(c.editor).toBeNull();
});

it("sanitizes unexpected failures and avoids redraws after disposal", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.perform(vi.fn<() => Promise<void>>().mockRejectedValue("unexpected"));
  expect(c.problem).toBe("unavailable");
  await c.perform(() => Promise.reject(Object.assign(new Error("fallback"), { code: 42 })));
  expect(c.problem).toBe("fallback");
  let reject: (error: Error) => void = () => {
    throw new Error("not started");
  };
  const running = c.perform(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const calls = f.changed.mock.calls.length;
  c.dispose();
  reject(new Error("aborted"));
  await running;
  expect(c.problem).toBeNull();
  expect(f.changed).toHaveBeenCalledTimes(calls);
});

it("does not apply a different saved revision or open a skill that disappeared", async () => {
  const f = await pendingSave();
  const c = f.controller;
  f.failures.delete("apply");
  if (!c.editor) throw new Error("editor");
  c.editor = { ...c.editor, expectedDigest: `sha256:${"0".repeat(64)}` };
  await c.apply();
  expect(c.problem).toBe("apply");
  const respond = f.request.getMockImplementation();
  if (!respond) throw new Error("fetch");
  f.request.mockImplementationOnce(async (path, init) => {
    const response = await respond(path, init);
    const body = (await response.json()) as { skill: object | null };
    return Response.json({ ...body, skill: null, editable: false });
  });
  c.discardEditor();
  await c.open(f.bundle.id);
  expect(c.problem).toBe("unavailable");
});

it("notifies subscribers before and after work, and after each local draft transition", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  expect(c.catalog).toEqual([]);
  expect(c.students).toEqual([]);
  const states: boolean[] = [];
  f.changed.mockImplementation(() => {
    states.push(c.busy);
  });
  await c.load();
  expect(states).toEqual([true, false]);
  const notified = (work: () => void) => {
    f.changed.mockClear();
    work();
    expect(f.changed).toHaveBeenCalledOnce();
  };
  notified(() => {
    c.create("didactic");
  });
  if (!c.editor) throw new Error("editor");
  const draft = c.editor.draft;
  notified(() => {
    c.edit(editSkillFields(draft, { title: "Changed" }));
  });
  notified(() => {
    c.closeEditor();
  });
  notified(() => {
    c.create("didactic");
  });
  notified(() => {
    c.discardEditor();
  });
  await c.open(f.bundle.id);
  notified(() => {
    c.editDetail();
  });
  expect(c.editor.key).toBe(f.bundle.id);
  notified(() => {
    c.closeDetail();
  });
  await c.perform(() => Promise.reject(Object.assign(new Error("private"), { code: "conflict" })));
  expect(c.problem).toBe("conflict");
});

it("treats absent editors and missing destinations as no-ops instead of errors", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  for (const action of [() => c.save(), () => c.apply(), () => c.reviewApplication()]) {
    await action();
    expect(c.problem).toBeNull();
  }
  expect(f.request).not.toHaveBeenCalled();
  c.create("didactic");
  await c.reviewApplication();
  expect(c.problem).toBeNull();
  await c.apply();
  expect(c.problem).toBeNull();
  await c.load();
  await c.open(f.bundle.id);
  c.editDetail(true);
  expect(c.editor?.key).toBe(`copy:${f.bundle.id}`);
});

it("retains saved and reviewed revisions in the draft cache and preserves active evaluation when appropriate", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  await c.open(f.bundle.id);
  c.editDetail();
  if (!c.editor) throw new Error("editor");
  const key = c.editor.key;
  f.failures.set("apply", 409);
  await c.save();
  expect(c.drafts.get(key)).toBe(c.editor);
  await c.reviewApplication();
  expect(c.drafts.get(key)).toBe(c.editor);
  c.discardEditor();
  f.failures.delete("apply");
  if (!c.configuration) throw new Error("configuration");
  const evaluation = [{ id: f.bundle.id, digest: f.bundle.digest }];
  c.configuration = {
    ...c.configuration,
    settings: {
      ...c.configuration.settings,
      automaticEvaluation: true,
      selection: { didactic: [], evaluation },
    },
  };
  await c.assignClass([]);
  expect(c.configuration.settings.automaticEvaluation).toBe(true);
  await c.assignClass(evaluation, "evaluation");
  expect(c.configuration.settings.automaticEvaluation).toBe(true);
  await c.assignClass([], "evaluation");
  expect(c.configuration.settings.automaticEvaluation).toBe(false);
});

async function pendingSave() {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  await c.open(f.bundle.id);
  c.editDetail();
  f.failures.set("apply", 409);
  await c.save();
  return f;
}

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
