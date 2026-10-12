import { expect, it, vi } from "vitest";
import { RequestIdSchema } from "@marea/protocol";
import { StudentSkills, LibrarySkills } from "./panes.js";
import { SkillDetail } from "./detail.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { skillWorkspaceMessages } from "./messages.js";
import { tree, text, control, change } from "../server-settings/forms.fixture.js";
const m = skillWorkspaceMessages("en");
function click(nodes: ReturnType<typeof tree>, caption: string) {
  const found = nodes.find((node) => node.type === "button" && text(node) === caption);
  if (!found) throw new Error(caption);
  (found.props.onClick as () => void)();
}
it("shows inherited and individual assignments, supports batch selection and restores inheritance", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  const search = vi.fn();
  const selectStudents = vi.fn();
  const personalize = vi.fn();
  const render = (selected: readonly string[] = [], query = "") =>
    tree(
      <StudentSkills
        c={c}
        m={m}
        query={query}
        search={search}
        selected={selected}
        selectStudents={selectStudents}
        personalize={personalize}
      />,
    );
  expect(render().filter((node) => node.type === "li")).toHaveLength(2);
  change(control(render(), m.studentSearch), { value: "ANA" });
  expect(search).toHaveBeenCalledWith("ANA");
  expect(render([], "ANA").filter((node) => node.type === "li")).toHaveLength(1);
  const checkbox = render().find((node) => node.props["aria-label"] === "Ana");
  (checkbox?.props.onChange as (e: object) => void)({ currentTarget: { checked: true } });
  expect(selectStudents).toHaveBeenCalledWith(["s1"]);
  const selected = render(["s1"]);
  (
    selected.find((node) => node.props["aria-label"] === "Ana")?.props.onChange as (
      e: object,
    ) => void
  )({ currentTarget: { checked: false } });
  expect(selectStudents).toHaveBeenLastCalledWith([]);
  click(selected, `${m.customizeMany} (1)`);
  expect(personalize).toHaveBeenLastCalledWith([c.students[0]]);
  click(render(), m.customize);
  expect(personalize).toHaveBeenLastCalledWith([c.students[0]]);
  await c.assignStudents(["s1"], []);
  expect(render().some((node) => text(node) === m.custom)).toBe(true);
  click(render(), m.inheritAction);
  await vi.waitFor(() => {
    expect(c.notice).toBe("assigned");
  });
  expect(c.students[0]?.selection).toBeNull();
  c.configuration = null;
  expect(
    render()
      .filter((node) => node.type === "button")
      .every((node) => node.props.disabled),
  ).toBe(true);
  const many = render(Array.from({ length: 100 }, (_, i) => `s${String(i + 2)}`));
  expect(many.find((node) => node.props["aria-label"] === "Ana")?.props.disabled).toBe(true);
  c.students = [];
  expect(render().some((node) => text(node) === m.noStudents)).toBe(true);
});
it("filters the library, switches practice/evaluation and modifies class selection", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  const search = vi.fn(),
    chooseKind = vi.fn(),
    pick = vi.fn(),
    filterSource = vi.fn();
  const selection = [{ id: f.bundle.id, digest: f.bundle.digest }];
  const render = (tab = "classroom", kind: "didactic" | "evaluation" = "didactic", query = "") =>
    tree(
      <LibrarySkills
        c={c}
        m={m}
        query={query}
        search={search}
        kind={kind}
        chooseKind={chooseKind}
        tab={tab}
        pick={pick}
        selection={selection}
        source="all"
        filterSource={filterSource}
        filterModule={vi.fn()}
        catalog={c.catalog}
      />,
    );
  click(render(), m.evaluation);
  expect(control(render(), m.module).value).toBe("");
  expect(chooseKind).toHaveBeenCalledWith("evaluation");
  click(render(), m.add);
  expect(pick).toHaveBeenCalledWith({ students: null, kind: "didactic", initial: selection });
  change(control(render(), m.search), { value: "test" });
  expect(search).toHaveBeenCalledWith("test");
  change(control(render("library"), m.library), { value: "teacher" });
  expect(filterSource).toHaveBeenCalledWith("teacher");
  expect(render("library", "evaluation").some((node) => text(node) === m.evaluationHelp)).toBe(
    true,
  );
  const open = render().find((node) => node.props.className === "skills-open");
  (open?.props.onClick as () => void)();
  await vi.waitFor(() => {
    expect(c.detail).not.toBeNull();
  });
  expect(render().find((node) => node.type === "li")?.props["aria-current"]).toBe("true");
  c.editDetail();
  expect(render().some((node) => node.type === "small" && text(node) === m.draft)).toBe(true);
  click(render(), m.remove);
  await vi.waitFor(() => {
    expect(c.notice).toBe("assigned");
  });
  expect(c.configuration?.settings.selection.didactic).toEqual([]);
  c.catalog = c.catalog.map((entry) => ({ ...entry, kind: "evaluation" }));
  expect(
    render("library", "evaluation").filter((node) => node.props.className === "skills-curriculum"),
  ).toHaveLength(0);
  c.catalog = [];
  expect(render().some((node) => text(node) === m.empty)).toBe(true);
  expect(
    render("classroom", "didactic", "missing").some((node) => text(node) === m.noResults),
  ).toBe(true);
  expect(render().some((node) => node.props.role === "alert" && text(node) === m.conflict)).toBe(
    true,
  );
});

it("shows names for assigned skills, retains missing-skill identities, and handles empty usage", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  const known = { id: f.bundle.id, digest: f.bundle.digest };
  c.students = [
    { studentId: "s1", displayName: "Ana", version: "revision:one", selection: [known] },
  ];
  const render = () => studentList(c);
  expect(render().some((node) => node.type === "p" && text(node) === "Unit testing")).toBe(true);
  c.catalog = [];
  expect(render().some((node) => node.type === "p" && text(node) === "testing")).toBe(true);
  await c.open(f.bundle.id);
  if (!c.usage) throw new Error("usage");
  c.usage = {
    ...c.usage,
    uses: [{ classId: "class:one", displayName: "Physics", classroom: false, students: 0 }],
  };
  const detail = tree(<SkillDetail controller={c} messages={m} assign={vi.fn()} />);
  expect(detail.filter((node) => node.type === "li").map(text)).toEqual(["Physics: "]);
});

it("keeps batch checkboxes and actions consistent at the selection limit and while saving", async () => {
  const { controller: c } = workspaceFixture();
  await c.load();
  const selectStudents = vi.fn();
  const render = (selected: readonly string[]) =>
    tree(
      <StudentSkills
        c={c}
        m={m}
        query=""
        search={vi.fn()}
        selected={selected}
        selectStudents={selectStudents}
        personalize={vi.fn()}
      />,
    );
  const atLimit = Array.from({ length: 99 }, (_, i) => `other${String(i)}`);
  const enabled = render(["s1", ...atLimit]);
  expect(enabled.find((node) => node.props["aria-label"] === "Ana")?.props.disabled).toBe(false);
  expect(enabled.find((node) => node.props["aria-label"] === "Pablo")?.props.disabled).toBe(true);
  expect(render(atLimit).find((node) => node.props["aria-label"] === "Pablo")?.props.disabled).toBe(
    false,
  );
  (
    enabled.find((node) => node.props["aria-label"] === "Ana")?.props.onChange as (
      event: object,
    ) => void
  )({ currentTarget: { checked: false } });
  expect(selectStudents).toHaveBeenLastCalledWith(atLimit);
  expect(
    render(["s1"])
      .filter((node) => node.type === "button")
      .every((node) => node.props.disabled === false),
  ).toBe(true);
  c.configuration = null;
  expect(
    render(["s1"]).find((node) => node.type === "button" && text(node) === `${m.customizeMany} (1)`)
      ?.props.disabled,
  ).toBe(true);
  c.busy = true;
  expect(
    render(["s1"])
      .filter((node) => node.type === "button" || node.props.type === "checkbox")
      .every((node) => node.props.disabled === true),
  ).toBe(true);
});

it("preserves other class assignments when removing one and only warns about missing class skills", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  const other = { id: "marea/other" as typeof f.bundle.id, digest: f.bundle.digest };
  const selection = [{ id: f.bundle.id, digest: f.bundle.digest }];
  const assign = vi.spyOn(c, "assignClass").mockResolvedValue();
  const render = (tab = "classroom") =>
    tree(
      <LibrarySkills
        c={c}
        m={m}
        query=""
        search={vi.fn()}
        kind="didactic"
        chooseKind={vi.fn()}
        tab={tab}
        pick={vi.fn()}
        selection={selection}
        source="all"
        filterSource={vi.fn()}
        catalog={c.catalog}
      />,
    );
  expect(render().some((node) => node.props.role === "alert")).toBe(false);
  selection.push(other);
  click(render(), m.remove);
  expect(assign).toHaveBeenCalledWith([other], "didactic");
  expect(render().some((node) => node.props.role === "alert")).toBe(true);
  expect(render("library").some((node) => node.props.role === "alert")).toBe(false);
  expect(
    render()
      .filter((node) => node.type === "button")
      .every((node) => !node.props.disabled),
  ).toBe(true);
  const entry = c.catalog[0];
  if (!entry) throw new Error("entry");
  c.catalog = [...c.catalog, { ...entry, id: other.id, title: "Other" }];
  expect(render().some((node) => node.props.role === "alert")).toBe(false);
  c.busy = true;
  expect(
    render()
      .filter(
        (node) =>
          node.props.className === "skills-open" || text(node) === m.add || text(node) === m.remove,
      )
      .every((node) => node.props.disabled === true),
  ).toBe(true);
  c.detail = {
    protocolVersion: "0.1",
    kind: "skill-authoring-read-result",
    requestId: RequestIdSchema.parse("request:test"),
    classId: "class:one",
    editable: false,
    skill: null,
  };
  expect(
    render()
      .filter((node) => node.type === "li")
      .every((node) => node.props["aria-current"] === undefined),
  ).toBe(true);
  c.busy = false;
  c.configuration = null;
  expect(
    render().find((node) => node.type === "button" && text(node) === m.add)?.props.disabled,
  ).toBe(true);
});

it("renders a mixed individual selection and disables detail actions during saves or without configuration", async () => {
  const f = workspaceFixture();
  const c = f.controller;
  await c.load();
  c.students = [
    {
      studentId: "s1",
      displayName: "Ana",
      version: "revision:one",
      selection: [
        { id: f.bundle.id, digest: f.bundle.digest },
        { id: "marea/missing" as typeof f.bundle.id, digest: f.bundle.digest },
      ],
    },
  ];
  const students = studentList(c);
  expect(students.some((node) => node.type === "p" && text(node) === "Unit testing, missing")).toBe(
    true,
  );
  await c.open(f.bundle.id);
  const render = () => tree(<SkillDetail controller={c} messages={m} assign={vi.fn()} />);
  expect(
    render().find((node) => node.type === "button" && text(node) === m.assignSkill)?.props.disabled,
  ).toBe(false);
  c.configuration = null;
  expect(
    render().find((node) => node.type === "button" && text(node) === m.assignSkill)?.props.disabled,
  ).toBe(true);
  c.busy = true;
  expect(
    render()
      .filter(
        (node) => node.type === "button" && [m.close, m.assignSkill, m.edit].includes(text(node)),
      )
      .every((node) => node.props.disabled === true),
  ).toBe(true);
  if (!c.detail) throw new Error("detail");
  c.detail = { ...c.detail, skill: { ...f.bundle, files: [] } };
  expect(render().find((node) => node.type === "pre")?.props.children).toBeUndefined();
});

function studentList(c: ReturnType<typeof workspaceFixture>["controller"]) {
  return tree(
    <StudentSkills
      c={c}
      m={m}
      query=""
      search={vi.fn()}
      selected={[]}
      selectStudents={vi.fn()}
      personalize={vi.fn()}
    />,
  );
}
