import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillsClass } from "./view.js";
import { buttons, click, skillViewFixture } from "./view-controls.fixture.js";
import { tree, text, control, change } from "../server-settings/forms.fixture.js";
const { hooks, refs, resetRender, mockReact, m } = await vi.hoisted(async () =>
  (await import("./view-hooks.fixture.js")).viewHooks(),
);
vi.mock("react", async (original) => mockReact(original));
vi.mock("../../browser-random-uuid.js", () => ({
  browserRandomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
const fixture = () => skillViewFixture(resetRender, m);
beforeEach(() => {
  hooks.values = [];
  hooks.effects = [];
  refs.values = [];
  resetRender();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it("keeps separate class, student and library views with stable filters and detail", async () => {
  const f = fixture();
  expect(f.render().some((node) => text(node) === m.loading)).toBe(true);
  await f.c.load();
  expect(f.render().some((node) => text(node) === m.empty)).toBe(true);
  f.click(m.library);
  expect(f.render().filter((node) => node.type === "li")).toHaveLength(1);
  change(control(f.render(), m.search), { value: "unmatched" });
  expect(f.render().some((node) => text(node) === m.noResults)).toBe(true);
  f.click(m.library);
  change(control(f.render(), m.library), { value: "marea" });
  expect(f.render().some((node) => text(node) === m.empty)).toBe(true);
  change(control(f.render(), m.library), { value: "teacher" });
  const open = f.render().find((node) => node.props.className === "skills-open");
  (open?.props.onClick as () => void)();
  await vi.waitFor(() => {
    expect(f.c.detail).not.toBeNull();
  });
  expect(f.render().some((node) => node.type === "aside")).toBe(true);
  f.click(m.students);
  expect(f.render().some((node) => node.type === "strong" && text(node) === "Ana")).toBe(true);
  f.click(m.library);
  f.click(m.newSkill);
  expect(f.c.editor?.draft.kind).toBe("didactic");
  expect(f.render().some((node) => node.type === "form")).toBe(true);
});
it("opens a modal, saves class skills and closes only on success", async () => {
  const f = fixture();
  await f.c.load();
  f.click(m.add);
  const nodes = f.render();
  const dialog = nodes.find((node) => node.type === "dialog");
  expect(dialog).toBeDefined();
  const showModal = vi.fn(),
    close = vi.fn();
  const ref = refs.values[0];
  if (!ref) throw new Error("ref");
  ref.current = { showModal, close };
  const cleanup = hooks.effects[0]?.();
  expect(showModal).toHaveBeenCalledOnce();
  cleanup?.();
  expect(close).toHaveBeenCalledOnce();
  change(control(nodes, "Unit testing"), { checked: true });
  f.failures.set("teaching-configuration-save", 409);
  f.click(m.select);
  await vi.waitFor(() => {
    expect(f.c.busy).toBe(false);
  });
  expect(f.render().some((node) => node.type === "dialog")).toBe(true);
  f.failures.delete("teaching-configuration-save");
  f.click(m.select);
  await vi.waitFor(() => {
    expect(f.c.notice).toBe("assigned");
  });
  expect(f.c.configuration?.settings.selection.didactic).toEqual([
    { id: f.bundle.id, digest: f.bundle.digest },
  ]);
  expect(f.render().some((node) => node.type === "dialog")).toBe(false);
  f.click(m.add);
  f.render();
  f.c.busy = true;
  (f.render().find((node) => node.type === "dialog")?.props.onCancel as (event: object) => void)({
    preventDefault: vi.fn(),
  });
  expect(f.render().some((node) => node.type === "dialog")).toBe(true);
  f.c.busy = false;
  (f.render().find((node) => node.type === "dialog")?.props.onCancel as (e: object) => void)({
    preventDefault: vi.fn(),
  });
  expect(f.render().some((node) => node.type === "dialog")).toBe(false);
});
it("personalizes a pupil, bulk selection and inheritance without changing class skills", async () => {
  const f = fixture();
  await f.c.load();
  f.click(m.students);
  f.click(m.customize);
  f.click(m.select);
  await vi.waitFor(() => {
    expect(f.c.notice).toBe("assigned");
  });
  expect(f.c.students[0]?.selection).toEqual([]);
  f.click(m.customize);
  f.click(m.inheritAction, 1);
  await vi.waitFor(() => {
    expect(f.c.busy).toBe(false);
  });
  expect(f.c.students[0]?.selection).toBeNull();
  for (const name of ["Ana", "Pablo"]) f.checkStudent(name);
  f.click(`${m.customizeMany} (2)`);
  expect(f.render().some((node) => text(node) === m.customHelp)).toBe(true);
  f.click(m.cancel);
  expect(f.render().some((node) => node.type === "dialog")).toBe(false);
});
it("adds a skill from detail and communicates free mode, configuration gaps and recoverable errors", async () => {
  const f = fixture();
  await f.c.load();
  await f.c.open(f.bundle.id);
  f.click(m.assignSkill);
  expect(control(f.render(), "Unit testing").checked).toBe(true);
  f.click(m.cancel);
  if (!f.c.configuration) throw new Error("config");
  f.c.configuration = {
    ...f.c.configuration,
    settings: { ...f.c.configuration.settings, agentMode: "free" },
  };
  expect(f.render().some((node) => text(node) === m.free)).toBe(true);
  f.c.configuration = null;
  expect(f.render().some((node) => text(node) === m.noConfiguration)).toBe(true);
  for (const [problem, message] of [
    ["apply", m.applyProblem],
    ["conflict", m.conflict],
    ["unavailable", m.unavailable],
  ] as const) {
    f.c.problem = problem;
    expect(f.render().some((node) => text(node) === message)).toBe(true);
  }
  f.click(m.reload);
  await vi.waitFor(() => {
    expect(f.c.configuration).not.toBeNull();
  });
});

it("preserves other selected skills when adding detail and handles an evaluator separately", async () => {
  const f = fixture();
  await f.c.load();
  await f.c.open(f.bundle.id);
  if (!f.c.configuration || !f.c.detail) throw new Error("fixture");
  f.c.configuration = {
    ...f.c.configuration,
    settings: {
      ...f.c.configuration.settings,
      selection: {
        ...f.c.configuration.settings.selection,
        didactic: [
          { id: f.bundle.id, digest: f.bundle.digest },
          { id: "marea/another" as typeof f.bundle.id, digest: f.bundle.digest },
        ],
      },
    },
  };
  f.click(m.assignSkill);
  expect(
    f.render().filter((node) => node.props.type === "checkbox" && node.props.checked),
  ).toHaveLength(2);
  f.click(m.cancel);
  f.c.detail = { ...f.c.detail, skill: { ...f.bundle, kind: "evaluation" } };
  f.c.catalog = f.c.catalog.map((entry) => ({ ...entry, kind: "evaluation" }));
  hooks.values = hooks.values.slice(0, 6);
  f.click(m.assignSkill);
  expect(control(f.render(), "Unit testing").checked).toBe(true);
  expect(f.render().some((node) => text(node) === "1 skills")).toBe(true);
  f.click(m.cancel);
});
it("keeps a failed inheritance action open and shows a non-conflict error inside the dialog", async () => {
  const f = fixture();
  await f.c.load();
  f.click(m.students);
  f.click(m.customize);
  f.failures.set("assign", 503);
  f.click(m.inheritAction);
  await vi.waitFor(() => {
    expect(f.c.problem).not.toBeNull();
  });
  const dialog = f.render().find((node) => node.type === "dialog");
  expect(dialog).toBeDefined();
  expect(
    tree(dialog).some((node) => node.props.role === "alert" && text(node) === m.unavailable),
  ).toBe(true);
});
it("recovers a stale bulk selection when its students disappear on refresh", async () => {
  const f = fixture();
  await f.c.load();
  f.click(m.students);
  (
    f.render().find((node) => node.props["aria-label"] === "Ana")?.props.onChange as (
      event: object,
    ) => void
  )({ currentTarget: { checked: true } });
  f.c.students = [];
  f.click(`${m.customizeMany} (1)`);
  expect(f.render().some((node) => node.type === "dialog")).toBe(false);
  expect(buttons(f.render(), `${m.customizeMany} (1)`)).toEqual([]);
});

it("preserves the readable workspace layout across class, library, student, detail, picker and editor states", async () => {
  const f = fixture();
  await f.c.load();
  const screenshot = (name: string) => {
    resetRender();
    expect(renderToStaticMarkup(<SkillsClass controller={f.c} messages={m} />)).toMatchSnapshot(
      name,
    );
  };
  screenshot("empty class");
  f.click(m.library);
  screenshot("personal library");
  await f.c.open(f.bundle.id);
  screenshot("skill details and usage");
  f.c.editDetail();
  screenshot("editing an assigned skill");
  f.c.closeEditor();
  f.c.closeDetail();
  hooks.values = hooks.values.slice(0, 6); // The editor unmounts before the picker mounts.
  f.click(m.students);
  screenshot("class inheritance");
  await f.c.assignStudents(["s1"], []);
  screenshot("individual empty selection");
  f.click(m.customize);
  screenshot("personal selection dialog");
  f.c.busy = true;
  screenshot("busy dialog");
  f.c.busy = false;
  f.c.problem = "conflict";
  screenshot("conflicting assignment");
  f.c.problem = null;
  f.click(m.cancel);
  hooks.values = hooks.values.slice(0, 6);
  f.click(m.library);
  f.click(m.library);
  f.click(m.newSkill);
  screenshot("new skill editor");
});

it("shows only selected skills of the chosen kind and searches titles and descriptions without case sensitivity", async () => {
  const f = fixture();
  await f.c.load();
  const first = f.c.catalog[0];
  if (!first || !f.c.configuration) throw new Error("fixture");
  const other = {
    ...first,
    id: "marea/other" as typeof first.id,
    title: "Other",
    description: "Different",
  };
  const evaluator = {
    ...first,
    id: "marea/judge" as typeof first.id,
    kind: "evaluation" as const,
    title: "Judge",
  };
  f.c.catalog = [first, other, evaluator];
  f.c.configuration = {
    ...f.c.configuration,
    settings: {
      ...f.c.configuration.settings,
      selection: { didactic: [{ id: first.id, digest: first.digest }], evaluation: [] },
    },
  };
  const names = () =>
    f
      .render()
      .filter((node) => node.props.className === "skills-open")
      .map(text);
  expect(names()).toEqual(["Unit testingPractice unit testing"]);
  f.click(m.library);
  expect(names()).toHaveLength(2);
  change(control(f.render(), m.search), { value: "UNIT" });
  expect(names()).toEqual(["Unit testingPractice unit testing"]);
  change(control(f.render(), m.search), { value: "practice" });
  expect(names()).toHaveLength(1);
  f.click(m.evaluation);
  expect(names()).toHaveLength(1);
  change(control(f.render(), m.search), { value: "" });
  expect(names()).toEqual(["JudgePractice unit testing"]);
  f.click(m.library);
  f.click(m.newSkill);
  f.c.closeEditor();
  hooks.values = hooks.values.slice(0, 6);
  expect(buttons(f.render(), m.library)[0]?.props["aria-current"]).toBe("page");
  f.click(m.classroom);
  f.c.configuration = null;
  expect(names()).toEqual([]);
  f.click(m.add);
  expect(f.render().some((node) => text(node) === m.noEvaluation)).toBe(true);
  expect(buttons(f.render(), m.inheritAction)).toEqual([]);
  f.click(m.cancel);
  hooks.values = hooks.values.slice(0, 6);
  f.click(m.practice);
  f.click(m.add);
  expect(f.render().some((node) => text(node) === m.emptyChoice)).toBe(true);
});

it("distinguishes one student's empty override from bulk class defaults and closes after restoring inheritance", async () => {
  const f = fixture();
  await f.c.load();
  const selection = [{ id: f.bundle.id, digest: f.bundle.digest }];
  await f.c.assignClass(selection);
  await f.c.assignStudents(["s1"], []);
  f.click(m.students);
  f.click(m.customize);
  expect(control(f.render(), "Unit testing").checked).toBe(false);
  f.click(m.cancel);
  hooks.values = hooks.values.slice(0, 6);
  for (const name of ["Ana", "Pablo"]) f.checkStudent(name);
  f.click(`${m.customizeMany} (2)`);
  expect(control(f.render(), "Unit testing").checked).toBe(true);
  const dialog = f.render().find((node) => node.type === "dialog");
  click(tree(dialog), m.inheritAction);
  await vi.waitFor(() => {
    expect(f.c.busy).toBe(false);
  });
  expect(f.render().some((node) => node.type === "dialog")).toBe(false);
  expect(f.c.students.every((student) => student.selection === null)).toBe(true);
});

it("replaces an existing evaluator and avoids duplicate practice references when assigning from details", async () => {
  const f = fixture();
  await f.c.load();
  await f.c.open(f.bundle.id);
  if (!f.c.configuration || !f.c.detail) throw new Error("fixture");
  const old = { id: "marea/old" as typeof f.bundle.id, digest: f.bundle.digest };
  f.c.configuration = {
    ...f.c.configuration,
    settings: {
      ...f.c.configuration.settings,
      selection: {
        didactic: [{ id: f.bundle.id, digest: f.bundle.digest }, old],
        evaluation: [old],
      },
    },
  };
  f.click(m.assignSkill);
  expect(f.render().find((node) => node.type === "dialog")).toBeDefined();
  expect(f.render().some((node) => node.type === "h3" && text(node) === m.add)).toBe(true);
  expect(
    tree(f.render().find((node) => node.type === "dialog")).some((node) => text(node) === m.future),
  ).toBe(true);
  expect(f.render().some((node) => text(node) === "2 skills")).toBe(true);
  f.click(m.cancel);
  hooks.values = hooks.values.slice(0, 6);
  f.c.detail = { ...f.c.detail, skill: { ...f.bundle, kind: "evaluation" } };
  f.c.catalog = f.c.catalog.map((entry) => ({ ...entry, kind: "evaluation" }));
  f.click(m.assignSkill);
  expect(f.render().some((node) => text(node) === "1 skills")).toBe(true);
});

it("handles a modal unmounted before its effect and prevents native dismissal while a save is pending", async () => {
  const f = fixture();
  await f.c.load();
  f.click(m.add);
  f.render();
  const cleanup = hooks.effects[0]?.();
  cleanup?.();
  const preventDefault = vi.fn();
  f.c.busy = true;
  (f.render().find((node) => node.type === "dialog")?.props.onCancel as (e: object) => void)({
    preventDefault,
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(f.render().some((node) => node.type === "dialog")).toBe(true);
});
it("returns from editing to an unfiltered library so the saved personal copy stays visible", async () => {
  const f = fixture();
  await f.c.load();
  f.click(m.library);
  change(control(f.render(), m.search), { value: "absent" });
  change(control(f.render(), m.library), { value: "marea" });
  f.click(m.library);
  change(control(f.render(), m.module), { value: "name:programación" });
  f.click(m.newSkill);
  f.click(m.back);
  expect(buttons(f.render(), m.library)[0]?.props["aria-current"]).toBe("page");
  expect(control(f.render(), m.search).value).toBe("");
  expect(control(f.render(), m.library).value).toBe("all");
  expect(control(f.render(), m.module).value).toBe("");
  expect(f.render().filter((node) => node.props.className === "skills-open")).toHaveLength(1);
});
it("filters library and picker by module and curricular reference, resetting the library on tab changes", async () => {
  const f = fixture();
  await f.c.load();
  const module = { nombre: "Programación", codigo: "0485" };
  f.c.catalog = f.c.catalog.map((entry) => ({
    ...entry,
    curriculum: { modulos: [module], referencias: [{ modulo: module, ra: 3, criterio: "f" }] },
  }));
  f.click(m.library);
  change(control(f.render(), m.module), { value: "unlinked" });
  expect(f.render().filter((node) => node.props.className === "skills-open")).toHaveLength(0);
  change(control(f.render(), m.module), { value: "code:0485" });
  change(control(f.render(), m.search), { value: "RA3.f" });
  expect(f.render().filter((node) => node.props.className === "skills-open")).toHaveLength(1);
  change(control(f.render(), m.search), { value: "RA3.g" });
  expect(f.render().filter((node) => node.props.className === "skills-open")).toHaveLength(0);
  f.click(m.classroom);
  f.click(m.library);
  expect(control(f.render(), m.module).value).toBe("");
  f.click(m.classroom);
  f.click(m.add);
  change(control(f.render(), m.module, 1), { value: "unlinked" });
  expect(f.render().filter((node) => node.props.type === "checkbox")).toHaveLength(0);
  change(control(f.render(), m.module, 1), { value: "code:0485" });
  change(control(f.render(), m.search, 1), { value: "RA3.f" });
  expect(f.render().filter((node) => node.props.type === "checkbox")).toHaveLength(1);
  change(control(f.render(), m.search, 1), { value: "RA3.g" });
  expect(f.render().filter((node) => node.props.type === "checkbox")).toHaveLength(0);
});
it("explains a failed generation while retaining the teacher's editor", () => {
  const f = fixture();
  f.c.create("didactic");
  f.c.problem = "generationProblem";
  expect(f.render().some((node) => text(node) === m.generationProblem)).toBe(true);
  expect(f.c.editor).not.toBeNull();
});
