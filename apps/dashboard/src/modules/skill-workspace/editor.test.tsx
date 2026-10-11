import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { SkillAuthoringDraft } from "@marea/protocol";
import { SkillEditor } from "./editor.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { skillWorkspaceMessages } from "./messages.js";
import { skillEditorFields, editSkillFields } from "./draft.boundary.js";
import { tree, text } from "../server-settings/forms.fixture.js";
import { importSkillFiles } from "./import-files.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("../server-settings/state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
vi.mock("./import-files.js", () => ({ importSkillFiles: vi.fn() }));
vi.mock("../../browser-random-uuid.js", () => ({
  browserRandomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
const m = skillWorkspaceMessages("en");
function fixture(kind: "didactic" | "evaluation" = "didactic") {
  const f = workspaceFixture();
  const c = f.controller;
  const onReturn = vi.fn();
  c.create(kind);
  const render = () => {
    hooks.index = 0;
    return tree(<SkillEditor controller={c} messages={m} onReturn={onReturn} />);
  };
  const button = (caption: string) => {
    const found = render().find((node) => node.type === "button" && text(node) === caption);
    if (!found) throw new Error(caption);
    return found;
  };
  const click = (caption: string) => {
    (button(caption).props.onClick as () => void)();
  };
  const field = (caption: string, index = 0) => {
    const label = render().filter(
      (node) => node.type === "label" && text(node).startsWith(caption),
    )[index];
    const input = tree(label?.props.children).find(
      (node) => node.type === "input" || node.type === "textarea",
    );
    if (!input) throw new Error(caption);
    return input;
  };
  const change = (caption: string, value: string, index = 0) => {
    (field(caption, index).props.onChange as (e: object) => void)({ currentTarget: { value } });
  };
  const submit = () => {
    (render().find((node) => node.type === "form")?.props.onSubmit as (e: object) => void)({
      preventDefault: vi.fn(),
    });
  };
  const draft = () => {
    if (!c.editor) throw new Error("editor");
    return c.editor.draft;
  };
  return { ...f, c, render, click, field, button, change, submit, draft, onReturn };
}
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
  vi.clearAllMocks();
});
it("validates on blur, retains stable error slots, previews instructions and saves a human-readable skill", async () => {
  const f = fixture();
  expect(f.render().filter((node) => node.props.className === "skills-field-error")).toHaveLength(
    3,
  );
  expect(f.field(m.name).props["aria-invalid"]).toBe(false);
  (f.field(m.name).props.onBlur as () => void)();
  expect(f.field(m.name).props["aria-invalid"]).toBe(true);
  f.submit();
  expect(f.render().some((node) => node.props.role === "alert" && text(node) === m.invalid)).toBe(
    true,
  );
  f.change(m.name, "Testing practice");
  f.change(m.description, "Practice small tests");
  f.change(m.instructions, "# Ask for one test\nUse **small cases**.");
  expect(f.field(m.name).props["aria-invalid"]).toBe(false);
  expect(f.render().find((node) => node.type === "h2")?.props.children).toBe("Testing practice");
  f.click(m.preview);
  expect(f.render().some((node) => node.type === "strong" && text(node) === "small cases")).toBe(
    true,
  );
  f.click(m.preview);
  expect(f.render().some((node) => node.props.className === "skills-preview")).toBe(false);
  f.submit();
  await vi.waitFor(() => {
    expect(f.c.notice).toBe("saved");
  });
  expect(f.c.editor).toBeNull();
  expect(f.onReturn).toHaveBeenCalledOnce();
  expect(f.render()).toEqual([]);
});
it("edits criteria and resources while preserving advanced metadata and remaining fields", () => {
  const f = fixture();
  f.click(m.addCriterion);
  f.click(m.addCriterion);
  f.change(m.code, "RA1", 0);
  f.change(m.statement, "Writes meaningful tests", 0);
  expect(skillEditorFields(f.draft())?.criteria).toEqual([
    { codigo: "RA1", enunciado: "Writes meaningful tests" },
    { codigo: "", enunciado: "" },
  ]);
  f.click(m.remove);
  expect(skillEditorFields(f.draft())?.criteria).toEqual([{ codigo: "", enunciado: "" }]);
  f.c.edit({
    ...f.draft(),
    files: [...f.draft().files, { path: "resources/example.txt", content: "old" }],
  });
  f.click(m.advanced);
  f.change("resources/example.txt", "new");
  expect(f.draft().files.find((file) => file.path === "resources/example.txt")?.content).toBe(
    "new",
  );
  f.change("SKILL.md", "broken");
  expect(f.render().find((node) => node.type === "h2")?.props.children).toBe(m.newSkill);
  expect(f.render().some((node) => node.props.role === "alert" && text(node) === m.invalid)).toBe(
    true,
  );
  f.click(m.remove);
  expect(f.draft().files).toHaveLength(1);
  f.click(m.basics);
  expect(f.field("SKILL.md").props.value).toBe("broken");
  f.submit();
  expect(f.c.busy).toBe(false);
});
it("offers evaluator instructions, preserves a draft on Back and allows explicit discard", () => {
  const f = fixture("evaluation");
  expect(f.field(m.evaluatorInstructions)).toBeDefined();
  expect(
    f.render().some((node) => node.type === "summary" && text(node).startsWith(m.criteria)),
  ).toBe(false);
  f.click(m.back);
  expect(f.onReturn).toHaveBeenCalledOnce();
  expect(f.c.editor).toBeNull();
  expect(f.c.drafts.size).toBe(1);
  f.c.create("evaluation");
  f.click(m.discard);
  expect(f.c.editor).toBeNull();
  expect(f.c.drafts.size).toBe(0);
});
it("shows assignment impact and recovers a saved revision without publishing it twice", async () => {
  const f = fixture();
  await f.c.load();
  await f.c.open(f.bundle.id);
  f.c.editDetail();
  expect(f.render().some((node) => text(node) === m.impact(1, 1))).toBe(true);
  expect(f.button(m.save).props.type).toBe("submit");
  f.failures.set("apply", 409);
  f.submit();
  await vi.waitFor(() => {
    expect(f.c.problem).toBe("apply");
  });
  expect(f.render().find((node) => node.type === "fieldset")?.props.disabled).toBe(true);
  expect(f.onReturn).not.toHaveBeenCalled();
  f.click(m.review);
  await vi.waitFor(() => {
    expect(f.c.busy).toBe(false);
  });
  f.failures.delete("apply");
  f.click(m.apply);
  await vi.waitFor(() => {
    expect(f.c.notice).toBe("saved");
  });
  expect(f.onReturn).toHaveBeenCalledOnce();
});
it("merges explicitly selected resources, reports errors and ignores a late import after navigation", async () => {
  const f = fixture();
  const upload = (files: object[] | null) => {
    const input = { files, value: "selected" };
    (f.render().find((node) => node.props.type === "file")?.props.onChange as (e: object) => void)({
      currentTarget: input,
    });
    return input;
  };
  const revised = editSkillFields(f.draft(), { title: "Imported" });
  vi.mocked(importSkillFiles).mockResolvedValueOnce(revised);
  const first = upload([{ name: "example.txt", webkitRelativePath: "" }]);
  await vi.waitFor(() => {
    expect(first.value).toBe("");
  });
  expect(f.draft()).toEqual(revised);
  vi.mocked(importSkillFiles).mockRejectedValueOnce(new Error("bad file"));
  const bad = upload(null);
  await vi.waitFor(() => {
    expect(bad.value).toBe("");
  });
  expect(f.render().some((node) => node.props.role === "alert" && text(node) === m.invalid)).toBe(
    true,
  );
  let resolve: (draft: SkillAuthoringDraft) => void = () => {
    throw new Error("not started");
  };
  vi.mocked(importSkillFiles).mockImplementationOnce(
    () =>
      new Promise((complete) => {
        resolve = complete;
      }),
  );
  const pending = upload([{ name: "example.txt", webkitRelativePath: "resources/example.txt" }]);
  f.c.closeEditor();
  resolve(revised);
  await vi.waitFor(() => {
    expect(pending.value).toBe("");
  });
  expect(f.c.editor).toBeNull();
});

it("disables saving during work and ignores failed imports after closing the editor", async () => {
  const f = fixture();
  f.c.busy = true;
  expect(f.button(m.working).props.disabled).toBe(true);
  f.c.busy = false;
  let reject: (reason: Error) => void = () => {
    throw new Error("not started");
  };
  vi.mocked(importSkillFiles).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const input = { files: [], value: "pending" };
  (
    f.render().find((node) => node.props.type === "file")?.props.onChange as (event: object) => void
  )({ currentTarget: input });
  f.c.closeEditor();
  reject(new Error("late failure"));
  await vi.waitFor(() => {
    expect(input.value).toBe("");
  });
  f.c.create("didactic");
  expect(f.render().some((node) => node.props.role === "alert")).toBe(false);
});

it("preserves the editor layout with criteria, resources, validation, previews and partial-save recovery", async () => {
  const f = fixture();
  const screenshot = (name: string) => {
    hooks.index = 0;
    expect(
      renderToStaticMarkup(<SkillEditor controller={f.c} messages={m} onReturn={f.onReturn} />),
    ).toMatchSnapshot(name);
  };
  f.submit();
  screenshot("required field feedback");
  f.change(m.name, "Testing");
  f.change(m.description, "Practice");
  f.change(m.instructions, "# Practice\nTry one case.");
  f.click(m.addCriterion);
  f.change(m.code, "RA1");
  f.change(m.statement, "Tests a boundary");
  f.c.edit({
    ...f.draft(),
    files: [...f.draft().files, { path: "resources/help.txt", content: "A companion file" }],
  });
  screenshot("criteria and resources");
  f.click(m.preview);
  screenshot("instructions preview");
  f.click(m.advanced);
  screenshot("advanced file editing");
  f.c.busy = true;
  screenshot("saving draft");
  f.c.busy = false;
  f.click(m.basics);
  f.failures.set("apply", 409);
  f.submit();
  await vi.waitFor(() => {
    expect(f.c.problem).toBe("apply");
  });
  screenshot("saved revision awaiting application");
});

it("keeps whitespace validation, the 64-criterion limit and precise import paths", async () => {
  const f = fixture();
  f.change(m.name, " ");
  (f.field(m.name).props.onBlur as () => void)();
  expect(f.field(m.name).props["aria-invalid"]).toBe(true);
  f.c.edit(
    editSkillFields(f.draft(), {
      criteria: Array.from({ length: 64 }, (_, i) => ({ codigo: `c${String(i)}`, enunciado: "" })),
    }),
  );
  expect(f.button(m.addCriterion).props.disabled).toBe(true);
  const original = f.draft();
  const selected = [
    { name: "one.txt", webkitRelativePath: "" },
    { name: "two.txt", webkitRelativePath: "resources/sub/two.txt" },
  ];
  let resolve: (draft: SkillAuthoringDraft) => void = () => {
    throw new Error("pending");
  };
  vi.mocked(importSkillFiles).mockImplementationOnce(
    () =>
      new Promise((complete) => {
        resolve = complete;
      }),
  );
  const input = { files: selected, value: "files" };
  (
    f.render().find((node) => node.props.type === "file")?.props.onChange as (event: object) => void
  )({ currentTarget: input });
  expect(importSkillFiles).toHaveBeenLastCalledWith(original, [
    { file: selected[0], path: "one.txt" },
    { file: selected[1], path: "resources/sub/two.txt" },
  ]);
  f.change(m.name, "Keep this edit");
  resolve(original);
  await vi.waitFor(() => {
    expect(input.value).toBe("");
  });
  expect(skillEditorFields(f.draft())?.title).toBe("Keep this edit");
  vi.mocked(importSkillFiles).mockRejectedValueOnce(new Error("empty"));
  (
    f.render().find((node) => node.props.type === "file")?.props.onChange as (event: object) => void
  )({ currentTarget: { files: null, value: "empty" } });
  expect(importSkillFiles).toHaveBeenLastCalledWith(f.draft(), []);
});
it("preserves the main file on advanced resource edits and blocks browser form navigation", () => {
  const f = fixture();
  const original = f.draft().files[0];
  f.c.edit({
    ...f.draft(),
    files: [...f.draft().files, { path: "resources/example.txt", content: "old" }],
  });
  f.click(m.advanced);
  f.change("resources/example.txt", "new");
  expect(f.draft().files[0]).toEqual(original);
  const preventDefault = vi.fn();
  (f.render().find((node) => node.type === "form")?.props.onSubmit as (event: object) => void)({
    preventDefault,
  });
  expect(preventDefault).toHaveBeenCalledOnce();
});
it("counts only class-wide usage and disables application until destinations have been reviewed", async () => {
  const f = fixture();
  await f.c.load();
  await f.c.open(f.bundle.id);
  f.c.editDetail();
  if (!f.c.editor?.usage) throw new Error("usage");
  f.c.editor = {
    ...f.c.editor,
    usage: {
      ...f.c.editor.usage,
      uses: [
        { classId: "c1", displayName: "First", classroom: true, students: 2 },
        { classId: "c2", displayName: "Second", classroom: false, students: 3 },
      ],
    },
  };
  expect(f.render().some((node) => text(node) === m.impact(1, 5))).toBe(true);
  f.c.create("evaluation");
  f.failures.set("usage", 503);
  await f.c.save();
  expect(f.c.editor.applyPending).toBe(true);
  expect(f.button(m.apply).props.disabled).toBe(true);
  f.failures.delete("usage");
  const calls = f.request.mock.calls.length;
  f.click(m.review);
  await vi.waitFor(() => {
    expect(f.c.busy).toBe(false);
  });
  expect(f.request.mock.calls.length).toBe(calls + 1);
  expect(f.button(m.apply).props.disabled).toBe(false);
  f.c.busy = true;
  expect(f.button(m.apply).props.disabled).toBe(true);
});

it("recovers a conflicting edit as a separate skill without overwriting the current library revision", async () => {
  const f = fixture();
  await f.c.load();
  await f.c.open(f.bundle.id);
  f.c.editDetail();
  f.change(m.name, "My unsaved lesson");
  const original = f.c.editor;
  f.failures.set("skill-authoring-save", 409);
  f.submit();
  await vi.waitFor(() => {
    expect(f.c.problem).toBe("conflict");
  });
  expect(f.c.editor).toEqual(original);
  f.c.busy = true;
  expect(f.button(m.copyDraft).props.disabled).toBe(true);
  f.c.copyEditor();
  expect(f.c.editor).toEqual(original);
  f.c.busy = false;
  f.changed.mockClear();
  f.click(m.copyDraft);
  expect(f.changed).toHaveBeenCalledOnce();
  if (!f.c.editor) throw new Error("editor");
  expect(f.c.editor.key).toBe(`copy:${f.c.editor.draft.slug}`);
  expect(f.c.problem).toBeNull();
  expect(f.c.editor).toMatchObject({
    expectedDigest: null,
    skillId: null,
    usage: null,
    applyPending: false,
  });
  expect(skillEditorFields(f.draft())?.title).toBe("My unsaved lesson");
  if (!original) throw new Error("editor");
  expect(f.c.drafts.get(original.key)).toEqual(original);
  expect(f.c.drafts.has(f.c.editor.key)).toBe(true);
  expect(f.c.editor.draft.slug).not.toBe(original.draft.slug);
  f.failures.delete("skill-authoring-save");
  f.submit();
  await vi.waitFor(() => {
    expect(f.c.notice).toBe("saved");
  });
  f.c.copyEditor();
  expect(f.c.editor).toBeNull();
});
