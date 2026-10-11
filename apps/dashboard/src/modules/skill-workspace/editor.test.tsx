import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillEditor } from "./editor.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { skillWorkspaceMessages } from "./messages.js";
import { tree, text } from "../server-settings/forms.fixture.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("../server-settings/state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
vi.mock("../../browser-random-uuid.js", () => ({
  browserRandomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
const m = skillWorkspaceMessages("en");
function fixture(kind: "didactic" | "evaluation" = "didactic") {
  const f = workspaceFixture();
  const c = f.controller;
  c.create(kind);
  const onReturn = vi.fn();
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
  const field = () => render().find((node) => node.props.id === "skill-markdown");
  const change = (content: string) => {
    (field()?.props.onChange as (event: object) => void)({ currentTarget: { value: content } });
  };
  const submit = () => {
    const preventDefault = vi.fn();
    (render().find((node) => node.type === "form")?.props.onSubmit as (e: object) => void)({
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  };
  return { ...f, c, onReturn, render, button, click, field, change, submit };
}
const markdown =
  "---\nname: unit-tests\ndescription: Practice\nmetadata:\n  title: Testing\ncriterios:\n  - codigo: local-1\n    enunciado: Tests a boundary\n    niveles: [Guided, Supported, Independent, Novel]\n---\n# Practice\nTry a **boundary** case.";
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});
it("shows the exact Markdown including criteria levels, validates in place and preserves companion files", async () => {
  const f = fixture();
  expect(f.field()?.props["aria-invalid"]).toBe(false);
  f.submit();
  expect(f.render().some((node) => text(node) === m.invalidDescription)).toBe(true);
  f.change(markdown);
  expect(f.c.editor?.draft.slug).toBe("unit-tests");
  expect(f.field()?.props.value).toBe(markdown);
  expect(f.field()?.props["aria-invalid"]).toBe(false);
  if (!f.c.editor) throw new Error("editor");
  f.c.edit({
    ...f.c.editor.draft,
    files: [...f.c.editor.draft.files, { path: "resources/old.txt", content: "keep" }],
  });
  expect(f.render().some((node) => text(node) === m.retainedFiles)).toBe(true);
  expect(f.render().some((node) => node.props.type === "file")).toBe(false);
  f.change(markdown + "\nSecond instruction");
  expect(f.c.editor.draft.files[1]).toEqual({ path: "resources/old.txt", content: "keep" });
  f.click(m.preview);
  expect(f.render().some((node) => node.type === "strong" && text(node) === "boundary")).toBe(true);
  f.click(m.preview);
  expect(f.render().some((node) => node.props.className === "skills-preview")).toBe(false);
  f.submit();
  await vi.waitFor(() => {
    expect(f.c.notice).toBe("saved");
  });
  expect(f.onReturn).toHaveBeenCalledOnce();
  expect(f.render()).toEqual([]);
});
it("keeps malformed Markdown editable, offers a kind-specific guide, Back and explicit discard", () => {
  const f = fixture("evaluation");
  expect(f.render().some((node) => text(node) === m.guideEvaluation)).toBe(true);
  f.change("broken");
  (f.field()?.props.onBlur as () => void)();
  expect(f.render().some((node) => text(node) === m.invalidYaml)).toBe(true);
  expect(f.render().find((node) => node.type === "h2")?.props.children).toBe(m.newSkill);
  f.submit();
  expect(f.c.busy).toBe(false);
  f.click(m.back);
  expect(f.onReturn).toHaveBeenCalledOnce();
  expect(f.c.drafts.size).toBe(1);
  f.c.create("evaluation");
  expect(f.field()?.props.value).toBe("broken");
  f.click(m.discard);
  expect(f.c.drafts.size).toBe(0);
});
it("preserves save/application recovery and disables edits while saving or awaiting application", async () => {
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
it("keeps conflict-copy controls and shows class versus individual assignment counts", async () => {
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
  f.c.problem = "conflict";
  f.c.busy = true;
  expect(f.button(m.copyDraft).props.disabled).toBe(true);
  expect(f.button(m.working).props.disabled).toBe(true);
  f.c.busy = false;
  f.click(m.copyDraft);
  expect(f.c.editor.expectedDigest).toBeNull();
  f.failures.set("usage", 503);
  await f.c.save();
  expect(f.button(m.apply).props.disabled).toBe(true);
  f.failures.delete("usage");
  f.click(m.review);
  await vi.waitFor(() => {
    expect(f.c.busy).toBe(false);
  });
  expect(f.button(m.apply).props.disabled).toBe(false);
  f.c.busy = true;
  expect(f.button(m.apply).props.disabled).toBe(true);
});
it("keeps a readable Markdown layout and a stable validation slot", () => {
  const f = fixture();
  f.change(markdown);
  f.render();
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<SkillEditor controller={f.c} messages={m} onReturn={f.onReturn} />),
  ).toMatchSnapshot();
  f.change("bad");
  (f.field()?.props.onBlur as () => void)();
  expect(f.render().filter((node) => node.props.id === "skill-markdown-error")).toHaveLength(1);
});
it("keeps a damaged draft editable even if its main file is missing", () => {
  const f = fixture();
  if (!f.c.editor) throw new Error("editor");
  f.c.edit({ ...f.c.editor.draft, files: [] });
  expect(f.field()?.props.value).toBe("");
  f.submit();
  expect(f.render().some((node) => text(node) === m.invalidSize)).toBe(true);
});
it("finds the main Markdown after resources and preserves the identity of a saved skill", async () => {
  const f = fixture();
  await f.c.open(f.bundle.id);
  f.c.editDetail();
  if (!f.c.editor) throw new Error("editor");
  f.c.edit({
    ...f.c.editor.draft,
    files: [{ path: "resources/first.txt", content: "resource" }, ...f.c.editor.draft.files],
  });
  expect(f.field()?.props.value).toBe(f.bundle.files[0]?.content);
  f.change("---\nname: renamed\ndescription: Good\n---\nBody");
  expect(f.c.editor.draft.slug).toBe("testing");
  (f.field()?.props.onBlur as () => void)();
  expect(f.field()?.props["aria-invalid"]).toBe(true);
  expect(f.render().some((node) => text(node) === m.invalidName)).toBe(true);
});
