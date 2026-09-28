import {
  completeModeInstructions,
  FREE_INSTRUCTIONS,
  TUTORING_INSTRUCTIONS,
  SkillIdSchema,
  TeachingSettingsSchema,
  type TeachingSettings,
} from "@marea/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TeachingEditor } from "./teaching-editor.js";
import { teachingMessages } from "./teaching-messages.js";
import {
  TEACHING_CATALOG_FIXTURE,
  TEACHING_DIGEST,
  TEACHING_STALE_DIGEST,
  teachingDraftFixture,
  teachingSelectedFixture,
  teachingStaleSelectionFixture,
  teachingSkillFixture,
} from "./teaching-view.fixture.js";
import { reviewElements } from "../evaluation/react-tree.fixture.js";

const m = teachingMessages("en");

function editor(
  settings = teachingDraftFixture(),
  edit = vi.fn<(settings: TeachingSettings) => void>(),
  disabled = false,
  catalog = TEACHING_CATALOG_FIXTURE,
) {
  const element = (
    <TeachingEditor
      settings={settings}
      catalog={catalog}
      disabled={disabled}
      messages={m}
      edit={edit}
    />
  );
  return { element, edit, elements: reviewElements(element) };
}

function box(elements: ReturnType<typeof reviewElements>, id: string) {
  return elements.find(
    (item) =>
      item.type === "input" &&
      ((item.props as { value?: string }).value ?? "").startsWith(`${id}:`),
  );
}

describe("teaching editor", () => {
  it("renders grouped catalog metadata with realistic names and descriptions", () => {
    const { element, elements } = editor(teachingSelectedFixture());
    const html = renderToStaticMarkup(element);
    expect(html).toContain(m.didacticLegend);
    expect(html).toContain(m.evaluationLegend);
    expect(html).toContain("guided-inquiry");
    expect(html).toContain("exercise-lab");
    expect(html).toContain("laboratory-rubric");
    expect(html).toContain("teacher");
    expect(html).toContain("center");
    expect(html).toContain("A deliberately long teaching description");
    expect(html).toContain(TEACHING_DIGEST);
    expect(elements.filter((item) => item.type === "input")).toHaveLength(4);
  });

  it("edits mode and both instruction fields without touching selections", () => {
    const base = teachingDraftFixture();
    const { edit, elements } = editor();
    const selects = elements.filter((item) => item.type === "select");
    const texts = elements.filter((item) => item.type === "textarea");
    expect(texts.map((item) => item.props.value)).toEqual([
      base.classInstructions.tutoring,
      base.classInstructions.free,
    ]);
    selects[0]?.props.onChange?.({ currentTarget: { value: "free" } });
    expect(edit).toHaveBeenLastCalledWith({ ...base, agentMode: "free" });
    selects[0]?.props.onChange?.({ currentTarget: { value: "tutoring" } });
    expect(edit).toHaveBeenLastCalledWith({ ...base, agentMode: "tutoring" });
    texts[0]?.props.onChange?.({ currentTarget: { value: "New guided plan" } });
    expect(edit).toHaveBeenLastCalledWith({
      ...base,
      classInstructions: { ...base.classInstructions, tutoring: "New guided plan" },
    });
    texts[1]?.props.onChange?.({ currentTarget: { value: "New free plan" } });
    expect(edit).toHaveBeenLastCalledWith({
      ...base,
      classInstructions: { ...base.classInstructions, free: "New free plan" },
    });
    const html = renderToStaticMarkup(
      <TeachingEditor
        settings={{ ...base, agentMode: "free" }}
        catalog={TEACHING_CATALOG_FIXTURE}
        disabled={false}
        messages={m}
        edit={vi.fn()}
      />,
    );
    expect(html).toContain(m.freeModeNote);
  });

  it("labels groups and capability notes exactly once per group", () => {
    const selectedHtml = renderToStaticMarkup(editor(teachingSelectedFixture()).element);
    const draftHtml = renderToStaticMarkup(editor(teachingDraftFixture()).element);
    const occurrences = (text: string) => selectedHtml.split(text).length - 1;
    const draftOccurrences = (text: string) => draftHtml.split(text).length - 1;
    expect(occurrences(m.didacticCap)).toBe(1);
    expect(occurrences(m.automaticEvaluationNote)).toBe(1);
    expect(draftOccurrences(m.automaticEvaluationNote)).toBe(2);
    expect(selectedHtml).toContain('class="teaching-skills teaching-skills-didactic"');
    expect(selectedHtml).toContain('class="teaching-skills teaching-skills-evaluation"');
    expect(selectedHtml).toContain('class="teaching-skill"');
    const both = TeachingSettingsSchema.parse({
      ...teachingDraftFixture(),
      selection: {
        didactic: [
          { id: SkillIdSchema.parse("marea/guided-inquiry"), digest: TEACHING_DIGEST },
          { id: SkillIdSchema.parse("teacher/alice/exercise-lab"), digest: TEACHING_STALE_DIGEST },
        ],
        evaluation: [],
      },
    });
    const exerciseBox = box(editor(both).elements, "teacher/alice/exercise-lab");
    expect((exerciseBox?.props as { checked?: boolean }).checked).toBe(true);
    const baseEditor = editor(teachingDraftFixture());
    const baseBox = box(baseEditor.elements, "marea/guided-inquiry");
    expect((baseBox?.props as { disabled?: boolean }).disabled).toBe(false);
    const evaluationBox = box(baseEditor.elements, "center/north/laboratory-rubric");
    expect((evaluationBox?.props as { disabled?: boolean }).disabled).toBe(false);
    const skillKeys = baseEditor.elements
      .filter((item) => (item.props as { className?: string }).className === "teaching-skill")
      .map((item) => item.key ?? "");
    expect(skillKeys.some((key) => key.includes("marea/guided-inquiry"))).toBe(true);
    expect(skillKeys.some((key) => key.includes("teacher/alice/exercise-lab"))).toBe(true);
  });

  it("toggles catalog selections and disables every control while blocked", () => {
    const base = teachingDraftFixture();
    const { edit, elements } = editor(base);
    box(elements, "marea/guided-inquiry")?.props.onChange?.({ currentTarget: { value: "" } });
    expect(edit).toHaveBeenLastCalledWith({
      ...base,
      selection: {
        didactic: [{ id: SkillIdSchema.parse("marea/guided-inquiry"), digest: TEACHING_DIGEST }],
        evaluation: [],
      },
    });
    const selected = editor(teachingSelectedFixture());
    box(selected.elements, "marea/guided-inquiry")?.props.onChange?.({
      currentTarget: { value: "" },
    });
    const lastSelection = selected.edit.mock.lastCall?.[0];
    expect(lastSelection?.selection.didactic).toEqual([]);
    const blockedBoxes = editor(teachingSelectedFixture(), vi.fn(), true).elements.filter(
      (item) => item.type === "input",
    );
    expect(blockedBoxes.map((item) => (item.props as { disabled?: boolean }).disabled)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("gates automatic evaluation on exactly one selected evaluation method", () => {
    const html = renderToStaticMarkup(
      <TeachingEditor
        settings={teachingSelectedFixture()}
        catalog={TEACHING_CATALOG_FIXTURE}
        disabled={false}
        messages={m}
        edit={vi.fn()}
      />,
    );
    expect(html).toContain(m.automaticEvaluation);
    expect(html).toContain('type="checkbox" checked=""');
    const automatic = editor(teachingSelectedFixture()).elements.filter(
      (item) => item.type === "input",
    )[3];
    expect((automatic?.props as { checked?: boolean }).checked).toBe(true);
    expect((automatic?.props as { disabled?: boolean }).disabled).toBe(false);
    const unavailable = editor(teachingDraftFixture()).elements.filter(
      (item) => item.type === "input",
    )[3];
    expect((unavailable?.props as { disabled?: boolean }).disabled).toBe(true);
    const { edit, elements } = editor(teachingSelectedFixture());
    elements
      .filter((item) => item.type === "input")[3]
      ?.props.onChange?.({
        currentTarget: { value: "on", checked: true },
      } as never);
    expect(edit).toHaveBeenLastCalledWith({
      ...teachingSelectedFixture(),
      automaticEvaluation: true,
    });
  });

  it("downgrades automatic evaluation when the selected method is removed", () => {
    const { edit, elements } = editor(teachingSelectedFixture());
    box(elements, "center/north/laboratory-rubric")?.props.onChange?.({
      currentTarget: { value: "" },
    });
    expect(edit).toHaveBeenLastCalledWith({
      ...teachingSelectedFixture(),
      selection: {
        didactic: teachingSelectedFixture().selection.didactic,
        evaluation: [],
      },
      automaticEvaluation: false,
    });
  });

  it("surfaces stale and missing selections with explicit reselect and remove actions", () => {
    const stale = teachingStaleSelectionFixture();
    const { edit, elements } = editor(stale);
    const buttons = elements.filter((item) => item.type === "button");
    const reselect = buttons.find(
      (item) => (item.props as { children?: string }).children === m.reselect,
    );
    const remove = buttons.find(
      (item) => (item.props as { children?: string }).children === m.remove,
    );
    reselect?.props.onClick?.();
    expect(edit).toHaveBeenLastCalledWith({
      ...stale,
      selection: {
        didactic: [
          { id: SkillIdSchema.parse("teacher/alice/exercise-lab"), digest: TEACHING_STALE_DIGEST },
        ],
        evaluation: [],
      },
    });
    remove?.props.onClick?.();
    expect(edit).toHaveBeenLastCalledWith({
      ...stale,
      selection: { didactic: [], evaluation: [] },
    });
    const staleEditor = editor(stale);
    const staleHtml = renderToStaticMarkup(staleEditor.element);
    expect(staleHtml).toContain(m.skillStale);
    expect(staleHtml).toContain('class="teaching-selection teaching-selection-stale"');
    const staleProblem = staleEditor.elements.find(
      (item) =>
        (item.props as { className?: string }).className ===
        "teaching-selection teaching-selection-stale",
    );
    expect(staleProblem?.key ?? "").toContain("teacher/alice/exercise-lab");
    const staleBox = box(staleEditor.elements, "teacher/alice/exercise-lab");
    expect((staleBox?.props as { checked?: boolean }).checked).toBe(false);
    const missing = TeachingSettingsSchema.parse({
      ...stale,
      selection: {
        didactic: [
          { id: SkillIdSchema.parse("teacher/ghost/vanished-lab"), digest: TEACHING_STALE_DIGEST },
        ],
        evaluation: [],
      },
    });
    const missingHtml = renderToStaticMarkup(
      <TeachingEditor
        settings={missing}
        catalog={TEACHING_CATALOG_FIXTURE}
        disabled={false}
        messages={m}
        edit={vi.fn()}
      />,
    );
    expect(missingHtml).toContain(m.skillMissing);
    expect(missingHtml).not.toContain(m.reselect);
    expect(missingHtml).toContain('class="teaching-selection teaching-selection-missing"');
  });

  it("blocks further selections once the didactic and evaluation caps are reached", () => {
    const many = Array.from({ length: 64 }, (_, index) => ({
      id: SkillIdSchema.parse(`teacher/school/skill-${String(index).padStart(2, "0")}`),
      digest: TEACHING_STALE_DIGEST,
    }));
    const capped = TeachingSettingsSchema.parse({
      ...teachingDraftFixture(),
      selection: { didactic: many, evaluation: [] },
    });
    const blockedDidactic = box(editor(capped).elements, "marea/guided-inquiry");
    expect((blockedDidactic?.props as { disabled?: boolean }).disabled).toBe(true);
    const secondEvaluation = teachingSkillFixture(
      SkillIdSchema.parse("center/south/quiz-design"),
      "quiz-design",
      "evaluation",
    );
    const blockedEvaluation = box(
      editor(
        TeachingSettingsSchema.parse({
          ...teachingDraftFixture(),
          selection: {
            didactic: [],
            evaluation: [
              {
                id: SkillIdSchema.parse("center/north/laboratory-rubric"),
                digest: TEACHING_DIGEST,
              },
            ],
          },
        }),
        vi.fn(),
        false,
        [secondEvaluation],
      ).elements,
      "center/south/quiz-design",
    );
    expect((blockedEvaluation?.props as { disabled?: boolean }).disabled).toBe(true);
  });
});

it("shows effective legacy text and converts both modes only on an explicit edit", () => {
  const legacy = {
    ...teachingDraftFixture(),
    classInstructions: { tutoring: "", free: "Keep this." },
  };
  const { elements, edit } = editor(legacy);
  const texts = elements.filter((item) => item.type === "textarea");
  expect(texts.map((item) => item.props.value)).toEqual([
    TUTORING_INSTRUCTIONS,
    `${FREE_INSTRUCTIONS}\n\nKeep this.`,
  ]);
  expect(edit).not.toHaveBeenCalled();
  texts[0]?.props.onChange?.({ currentTarget: { value: "My complete tutor." } });
  expect(edit).toHaveBeenLastCalledWith({
    ...legacy,
    classInstructions: {
      ...completeModeInstructions(legacy.classInstructions),
      tutoring: "My complete tutor.",
    },
  });
  elements
    .find((item) => item.type === "select")
    ?.props.onChange?.({ currentTarget: { value: "free" } });
  expect(edit).toHaveBeenLastCalledWith({
    ...legacy,
    agentMode: "free",
    classInstructions: completeModeInstructions(legacy.classInstructions),
  });
});
it("restores each mode in the draft without overwriting the other mode", () => {
  const base = teachingDraftFixture();
  const { elements, edit } = editor(base);
  const buttons = elements.filter((item) => item.type === "button");
  buttons.find((item) => item.props.children === m.restoreTutoring)?.props.onClick?.();
  expect(edit).toHaveBeenLastCalledWith({
    ...base,
    classInstructions: { ...base.classInstructions, tutoring: TUTORING_INSTRUCTIONS },
  });
  buttons.find((item) => item.props.children === m.restoreFree)?.props.onClick?.();
  expect(edit).toHaveBeenLastCalledWith({
    ...base,
    classInstructions: { ...base.classInstructions, free: FREE_INSTRUCTIONS },
  });
});
