import { RunIdSchema, TeacherEvaluationSchema } from "@marea/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EvaluationController, type EvaluationState } from "./evaluation-controller.js";
import { EvaluationEditor } from "./evaluation-editor.js";
import { evaluationMessages } from "./evaluation-messages.js";
import { EvaluationModule } from "./evaluation-module.js";
import {
  DRAFT,
  HISTORY,
  METADATA,
  NOW,
  RECORD,
  SESSIONS,
  evaluationClientFixture,
} from "./evaluation.fixture.js";
import { reviewButton, reviewElements } from "./react-tree.fixture.js";

function setup(patch: Partial<EvaluationState> = {}) {
  const controller = new EvaluationController(evaluationClientFixture(), vi.fn());
  const state = {
    ...controller.state,
    runId: "run:one",
    sessions: SESSIONS,
    history: HISTORY,
    draft: DRAFT,
    evaluation: RECORD,
    ...patch,
  };
  return { controller, state };
}

describe("evaluation review surface", () => {
  it.each(["en", "es"] as const)(
    "has complete %s review copy and a stable accessible draft view",
    (locale) => {
      expect(evaluationMessages(locale)).toMatchSnapshot();
      const { controller, state } = setup();
      expect(
        renderToStaticMarkup(
          <EvaluationModule locale={locale} state={state} controller={controller} />,
        ),
      ).toMatchSnapshot();
    },
  );

  it("renders empty, loading, failed and unselected states without inventing an evaluation", () => {
    const { controller } = setup();
    const initial = renderToStaticMarkup(
      <EvaluationModule locale="es" state={controller.state} controller={controller} />,
    );
    expect(initial).toContain("Selecciona una sesión cerrada");
    expect(initial).not.toContain("Nota privada");
    expect(initial).not.toContain('class="run-card"');
    expect(initial).not.toContain("No hay sesiones cerradas");
    expect(initial).not.toContain("Procesando");
    const { state } = setup({
      sessions: {
        ...SESSIONS,
        runs: [
          {
            ...SESSIONS.runs[0],
            runId: RunIdSchema.parse("run:active"),
            state: "active",
            studentDisplayName: "Other student",
            classDisplayName: "Class",
            projectDisplayName: "Project",
            openedAt: NOW,
            closedAt: null,
          },
        ],
        nextBeforeRunId: null,
      },
      busy: true,
      error: true,
      evaluation: null,
      draft: null,
      history: null,
    });
    const html = renderToStaticMarkup(
      <EvaluationModule locale="en" state={state} controller={controller} />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Working…");
    expect(html).toContain('role="alert"');
    expect(html).toContain("No closed sessions on this page.");
    expect(html).toContain("No evaluation yet.");
    expect(html).not.toContain("Other student");
    expect(html).not.toContain("Older sessions");
    expect(
      reviewElements(<EvaluationModule locale="en" state={state} controller={controller} />)
        .filter((element) => element.type === "button")
        .every((button) => button.props.disabled),
    ).toBe(true);
  });

  it("connects every review action, cursor and edit to its controller", () => {
    const { controller, state } = setup();
    const load = vi.spyOn(controller, "loadSessions").mockResolvedValue();
    const select = vi.spyOn(controller, "select").mockResolvedValue();
    const refresh = vi.spyOn(controller, "refresh").mockResolvedValue();
    const generate = vi.spyOn(controller, "generate").mockResolvedValue();
    const approve = vi.spyOn(controller, "approve").mockResolvedValue();
    const nextHistory = vi.spyOn(controller, "nextHistory").mockResolvedValue();
    const edit = vi.spyOn(controller, "edit").mockImplementation(() => undefined);
    const elements = reviewElements(
      <EvaluationModule locale="en" state={state} controller={controller} />,
    );
    for (const label of [
      "Load sessions",
      "Older sessions",
      "Review",
      "Reload review (discard local edits)",
      "Generate new draft",
      "Approve and send feedback",
      "Next evidence page",
    ])
      reviewButton(elements, label).props.onClick?.();
    expect(load).toHaveBeenCalledWith();
    expect(load).toHaveBeenCalledWith("run:one");
    expect(select).toHaveBeenCalledWith("run:one");
    expect(refresh).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
    expect(nextHistory).toHaveBeenCalledOnce();
    elements
      .find((element) => element.type === "textarea")
      ?.props.onChange?.({ currentTarget: { value: "Reviewed public text" } });
    expect(edit).toHaveBeenCalledWith({ ...DRAFT, studentFeedback: "Reviewed public text" });
  });

  it("does not offer approval for queued, running, failed or already-approved work", () => {
    const variants = [
      { state: "queued" },
      { state: "running" },
      { state: "failed", failure: "interrupted" },
      { state: "approved", draft: DRAFT, noticeId: "notice:one", approvedAt: NOW },
    ];
    for (const variant of variants) {
      const evaluation = TeacherEvaluationSchema.parse({ ...METADATA, ...variant });
      const { controller, state } = setup({
        evaluation,
        draft: evaluation.state === "approved" ? DRAFT : null,
        history: { ...HISTORY, nextSequence: null },
        runId: "run:other",
      });
      const view = <EvaluationModule locale="en" state={state} controller={controller} />;
      const html = renderToStaticMarkup(view);
      expect(html).toContain(evaluationMessages("en")[evaluation.state]);
      expect(html).not.toContain("Approve and send feedback");
      expect(html).not.toContain("Next evidence page");
      expect(html).not.toContain('aria-current="true"');
      if (evaluation.state === "failed")
        expect(html).toContain("Generation was interrupted. A new attempt needs a new draft.");
      const elements = reviewElements(view);
      expect(reviewButton(elements, "Generate new draft").props.disabled).toBe(
        evaluation.state === "queued" || evaluation.state === "running",
      );
      if (evaluation.state === "approved")
        expect(elements.find((element) => element.type === "fieldset")?.props.disabled).toBe(true);
    }
  });

  it.each(["generate", "approve"] as const)(
    "locks edits after an uncertain %s and exposes only its matching retry",
    (pendingKind) => {
      const { controller, state } = setup({ uncertain: true, pendingKind });
      const elements = reviewElements(
        <EvaluationModule locale="en" state={state} controller={controller} />,
      );
      expect(elements.find((element) => element.type === "fieldset")?.props.disabled).toBe(true);
      expect(reviewButton(elements, "Retry the same request").props.disabled).toBe(false);
      expect(
        reviewButton(
          elements,
          pendingKind === "generate" ? "Approve and send feedback" : "Generate new draft",
        ).props.disabled,
      ).toBe(true);
    },
  );

  it("allows a first generation while keeping an orphaned local draft read-only", () => {
    const { controller, state } = setup({ evaluation: null, draft: DRAFT });
    const elements = reviewElements(
      <EvaluationModule locale="en" state={state} controller={controller} />,
    );
    expect(reviewButton(elements, "Generate new draft").props.disabled).toBe(false);
    expect(elements.find((element) => element.type === "fieldset")?.props.disabled).toBe(true);
  });

  it("keeps untrusted evidence and feedback as text, never executable markup", () => {
    const { controller, state } = setup({
      draft: { ...DRAFT, studentFeedback: "<script>alert(1)</script>" },
    });
    const html = renderToStaticMarkup(
      <EvaluationModule locale="en" state={state} controller={controller} />,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("teacher draft editor", () => {
  it("edits each field without losing private content, criterion identity or typed whitespace", () => {
    const first = DRAFT.criteria[0];
    if (first === undefined) throw new Error("Expected criterion fixture");
    const draft = {
      ...DRAFT,
      difficulties: ["One", "Two"],
      criteria: [
        { ...first, evidence: "old" },
        { ...first, code: "C2" },
      ],
    };
    const edit = vi.fn();
    const elements = reviewElements(
      <EvaluationEditor
        draft={draft}
        disabled={false}
        messages={evaluationMessages("en")}
        edit={edit}
      />,
    );
    const texts = elements.filter((element) => element.type === "textarea");
    const selects = elements.filter((element) => element.type === "select");
    expect(texts).toHaveLength(5);
    expect(selects).toHaveLength(4);
    expect(texts[2]?.props.value).toBe("One\nTwo");
    const fields = elements.filter((element) => element.type === "fieldset").slice(1);
    expect(fields[0]?.key).toContain("C1");
    expect(fields[1]?.key).toContain("C2");
    texts[0]?.props.onChange?.({ currentTarget: { value: " Public text " } });
    expect(edit).toHaveBeenLastCalledWith({ ...draft, studentFeedback: " Public text " });
    texts[1]?.props.onChange?.({ currentTarget: { value: "Private edit" } });
    expect(edit).toHaveBeenLastCalledWith({ ...draft, teacherNote: "Private edit" });
    texts[2]?.props.onChange?.({ currentTarget: { value: "One\nTwo\n" } });
    expect(edit).toHaveBeenLastCalledWith({ ...draft, difficulties: ["One", "Two", ""] });
    selects[0]?.props.onChange?.({ currentTarget: { value: "passed" } });
    expect(edit).toHaveBeenLastCalledWith({
      ...draft,
      criteria: [{ ...first, evidence: "old", result: "passed" }, draft.criteria[1]],
    });
    selects[1]?.props.onChange?.({ currentTarget: { value: "high" } });
    expect(edit).toHaveBeenLastCalledWith({
      ...draft,
      criteria: [{ ...first, evidence: "old", confidence: "high" }, draft.criteria[1]],
    });
    texts[3]?.props.onChange?.({ currentTarget: { value: "New words " } });
    expect(edit).toHaveBeenLastCalledWith({
      ...draft,
      criteria: [{ ...first, evidence: "New words " }, draft.criteria[1]],
    });
    texts[3]?.props.onChange?.({ currentTarget: { value: "" } });
    expect(edit).toHaveBeenLastCalledWith({
      ...draft,
      criteria: [{ ...first, evidence: "" }, draft.criteria[1]],
    });
    edit.mockClear();
    selects[0]?.props.onChange?.({ currentTarget: { value: "approved" } });
    expect(edit).not.toHaveBeenCalled();
    expect(draft.criteria[0]).toMatchObject({ evidence: "old" });
    expect(
      renderToStaticMarkup(
        <EvaluationEditor
          draft={{ ...DRAFT, criteria: [] }}
          disabled
          messages={evaluationMessages("es")}
          edit={edit}
        />,
      ),
    ).toContain("(0)");
  });
});
it.each([undefined, "Previous guidance"])("edits adaptive learning notes (%s)", (learningNote) => {
  const first = DRAFT.criteria[0];
  if (!first) throw new Error("missing criterion");
  const criterion = {
    ...first,
    levelAttempted: 2,
    ...(learningNote === undefined ? {} : { learningNote }),
  };
  const draft = { ...DRAFT, criteria: [criterion] };
  const edit = vi.fn();
  const elements = reviewElements(
    <EvaluationEditor
      draft={draft}
      disabled={false}
      messages={evaluationMessages("en")}
      edit={edit}
    />,
  );
  expect(
    renderToStaticMarkup(
      <EvaluationEditor
        draft={draft}
        disabled={false}
        messages={evaluationMessages("en")}
        edit={edit}
      />,
    ),
  ).toContain(" · 2/4");
  const notes = elements.filter((element) => element.type === "textarea")[3];
  expect(notes?.props.value).toBe(learningNote ?? "");
  notes?.props.onChange?.({ currentTarget: { value: "Practice independently" } });
  expect(edit).toHaveBeenCalledWith({
    ...draft,
    criteria: [{ ...criterion, learningNote: "Practice independently" }],
  });
});
