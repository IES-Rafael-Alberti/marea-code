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
it("generates directly in the unsaved editor, preserves text on failure and supports undo", async () => {
  const f = workspaceFixture(),
    c = f.controller;
  const { render, button, click } = editorControls(hooks, () => <SkillGeneration c={c} m={m} />);
  expect(render()).toEqual([]);
  c.applyGenerated("ignored");
  c.undoGeneration();
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
  expect(c.editor?.draft).toBe(original);
  await vi.waitFor(() => {
    expect(c.beforeGeneration).toBe(original);
  });
  const generated = c.editor?.draft;
  expect(generated).not.toBe(original);
  expect(c.drafts.get(c.editor?.key ?? "")?.draft).toBe(generated);
  expect(render().some((node) => node.type === "pre")).toBe(false);
  const body = f.request.mock.calls[0]?.[1].body;
  expect(
    SkillWorkspaceRequestSchema.parse(JSON.parse(typeof body === "string" ? body : "")),
  ).toMatchObject({
    kind: "generate",
    instructions: "RA1: Bucles y casos límite",
    skillKind: "didactic",
    locale: "en",
  });
  c.busy = true;
  expect(button(m.undoGeneration).props.disabled).toBe(true);
  c.undoGeneration();
  expect(c.editor?.draft).toBe(generated);
  c.busy = false;
  expect(button(m.undoGeneration).props.disabled).toBe(false);
  click(m.undoGeneration);
  expect(c.editor?.draft).toBe(original);
  expect(c.beforeGeneration).toBeNull();
  c.undoGeneration();
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
    expect(c.beforeGeneration).toBe(original);
  });
  expect(
    f.request.mock.calls.some(
      ([, options]) =>
        typeof options.body === "string" && options.body.includes("skill-authoring-save"),
    ),
  ).toBe(false);
  if (!c.editor) throw new Error("editor");
  c.editor = { ...c.editor, applyPending: true };
  expect(button(m.generate).props.disabled).toBe(true);
  expect(button(m.undoGeneration).props.disabled).toBe(true);
  c.undoGeneration();
  expect(c.beforeGeneration).toBe(original);
});
it("ignores generation without an editable draft and late responses after closing or disposal", async () => {
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
  expect(c.beforeGeneration).toBeNull();
  c.undoGeneration();
  expect(c.editor).toBeNull();
  c.create("didactic");
  const replaced = c.generate("notes", "es");
  c.create("evaluation");
  const current = c.editor;
  await replaced;
  expect(c.editor).toBe(current);
  expect(c.beforeGeneration).toBeNull();
  const original = c.editor;
  const disposed = c.generate("notes", "es");
  c.dispose();
  await disposed;
  expect(c.editor).toBe(original);
  expect(c.beforeGeneration).toBeNull();
});
