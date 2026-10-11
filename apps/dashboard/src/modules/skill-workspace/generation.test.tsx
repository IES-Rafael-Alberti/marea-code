import { beforeEach, expect, it, vi } from "vitest";
import { SkillWorkspaceRequestSchema } from "@marea/protocol";
import { SkillGeneration } from "./generation.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { skillWorkspaceMessages } from "./messages.js";
import { editorControls } from "./editor-controls.fixture.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("../server-settings/state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
const m = skillWorkspaceMessages("en");
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});
it("generates a separate proposal from free text, preserves edits on failure and only replaces Markdown on explicit use", async () => {
  const f = workspaceFixture(),
    c = f.controller;
  const { render, button, click } = editorControls(hooks, () => <SkillGeneration c={c} m={m} />);
  expect(render()).toEqual([]);
  c.create("didactic");
  expect(button(m.generate).props.disabled).toBe(true);
  const editNotes = (value: string) => {
    (render().find((node) => node.type === "textarea")?.props.onChange as (e: object) => void)({
      currentTarget: { value },
    });
  };
  editNotes("  ");
  expect(button(m.generate).props.disabled).toBe(true);
  editNotes("RA1: Bucles y casos límite");
  expect(button(m.generate).props.disabled).toBe(false);
  const original = c.editor?.draft;
  click(m.generate);
  expect(button(m.generating).props.disabled).toBe(true);
  await vi.waitFor(() => {
    expect(c.generated).not.toBeNull();
  });
  expect(c.editor?.draft).toBe(original);
  expect(render().find((node) => node.type === "pre")?.props.children).toBe(c.generated);
  const body = f.request.mock.calls[0]?.[1].body;
  const request = SkillWorkspaceRequestSchema.parse(
    JSON.parse(typeof body === "string" ? body : ""),
  );
  expect(request).toMatchObject({
    kind: "generate",
    instructions: "RA1: Bucles y casos límite",
    skillKind: "didactic",
    locale: "en",
  });
  c.busy = true;
  expect(button(m.useGenerated).props.disabled).toBe(true);
  expect(button(m.discardGenerated).props.disabled).toBe(true);
  c.acceptGenerated();
  expect(c.editor?.draft).toBe(original);
  c.busy = false;
  click(m.discardGenerated);
  expect(c.generated).toBeNull();
  expect(c.editor?.draft).toBe(original);
  f.failures.set("generate", 422);
  click(m.generate);
  await vi.waitFor(() => {
    expect(c.problem).toBe("generationProblem");
  });
  expect(c.editor?.draft).toBe(original);
  expect(render().find((node) => node.type === "textarea")?.props.value).toBe(
    "RA1: Bucles y casos límite",
  );
  f.failures.delete("generate");
  click(m.generate);
  await vi.waitFor(() => {
    expect(c.generated).not.toBeNull();
  });
  const proposal = c.generated;
  click(m.useGenerated);
  expect(c.editor?.draft.files[0]?.content).toBe(proposal);
  expect(c.generated).toBeNull();
  expect(
    f.request.mock.calls.some(
      ([, options]) =>
        typeof options.body === "string" && options.body.includes("skill-authoring-save"),
    ),
  ).toBe(false);
  c.acceptGenerated();
  expect(c.generated).toBeNull();
  if (!c.editor) throw new Error("editor");
  c.editor = { ...c.editor, applyPending: true };
  expect(button(m.generate).props.disabled).toBe(true);
  c.generated = "keep";
  c.acceptGenerated();
  expect(c.generated).toBe("keep");
});
it("ignores generation when there is no editable draft and does not revive an editor closed during a request", async () => {
  const f = workspaceFixture(),
    c = f.controller;
  await c.generate("notes", "es");
  expect(f.request).not.toHaveBeenCalled();
  c.create("evaluation");
  if (!c.editor) throw new Error("editor");
  c.editor = { ...c.editor, applyPending: true };
  await c.generate("notes", "es");
  expect(f.request).not.toHaveBeenCalled();
  c.editor = { ...c.editor, applyPending: false };
  const pending = c.generate("notes", "es");
  c.closeEditor();
  await pending;
  expect(c.generated).toBeNull();
  c.acceptGenerated();
  expect(c.editor).toBeNull();
});
