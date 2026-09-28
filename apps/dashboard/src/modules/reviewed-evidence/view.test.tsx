import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";
import { ReviewedEvidenceView } from "./view.js";
import { ReviewedEvidenceController } from "./controller.js";
import { criterion, entry, page, query } from "./evidence.fixture.js";
import { reviewedEvidenceMessages } from "./messages.js";

it.each(["en", "es", "eu"] as const)(
  "renders every state and reviewed history in %s without a learning score",
  (locale) => {
    const controller = new ReviewedEvidenceController({ read: vi.fn() }, vi.fn());
    const render = () =>
      renderToStaticMarkup(
        <ReviewedEvidenceView locale={locale} controller={controller} openSession={vi.fn()} />,
      );
    const m = reviewedEvidenceMessages(locale);
    for (const status of ["empty", "loading", "error", "denied"] as const) {
      controller.status = status;
      expect(render()).toContain(m[status]);
    }
    controller.status = "ready";
    controller.response = page();
    expect(render()).toContain("Synthetic student");
    expect(render()).toContain("s1");
    controller.response = page({ entries: [] });
    expect(render()).toContain(m.none);
    controller.response = page({
      kind: "criteria",
      query: query({ kind: "criteria", studentId: "s1" }),
      entries: [{ ...criterion, statement: "Frozen boundary" }],
      next: criterion,
    });
    expect(render()).toContain("Frozen boundary");
    expect(render()).toContain(criterion.digest);
    expect(render()).toContain(m.more);
    for (const result of ["passed", "not-passed", "no-evidence"] as const)
      for (const confidence of ["low", "medium", "high"] as const) {
        controller.response = page({
          kind: "history",
          query: query({ kind: "history", studentId: "s1", criterion }),
          entries: [{ ...entry, result, confidence, hasLaterApproval: true }],
        });
        expect(render()).toContain(m[result]);
        expect(render()).toContain(m[confidence]);
        expect(render()).toContain(m.older);
        expect(render()).toContain("Reviewed boundary");
        expect(render()).toContain(m.meaning);
        expect(render()).toContain(m.generation);
      }
    controller.navigationBlocked = true;
    expect(render()).toContain(m.blocked);
  },
);
it("wires paging, student/criterion selection, refresh and source navigation", () => {
  const controller = new ReviewedEvidenceController({ read: vi.fn() }, vi.fn());
  const openSession = vi.fn();
  const methods = ["students", "criteria", "history", "refresh", "more", "open"] as const;
  const spies = Object.fromEntries(
    methods.map((method) => [method, vi.spyOn(controller, method).mockResolvedValue()]),
  );
  const click = (text: string) =>
    reviewButton(
      reviewElements(
        <ReviewedEvidenceView locale="en" controller={controller} openSession={openSession} />,
      ),
      text,
    ).props.onClick?.();
  const m = reviewedEvidenceMessages("en");
  controller.response = page({ next: "s1" });
  click(m.students);
  click(m.refresh);
  click(m.more);
  click("Synthetic student · s1");
  expect(spies.students).toHaveBeenCalledOnce();
  expect(spies.refresh).toHaveBeenCalledOnce();
  expect(spies.more).toHaveBeenCalledOnce();
  expect(spies.criteria).toHaveBeenCalledWith("s1");
  controller.response = page({
    kind: "criteria",
    query: query({ kind: "criteria", studentId: "s1" }),
    entries: [{ ...criterion, statement: "Frozen" }],
  });
  click(m.history);
  expect(spies.history).toHaveBeenCalledWith("s1", criterion);
  controller.response = page({
    kind: "history",
    query: query({ kind: "history", studentId: "s1", criterion }),
    entries: [entry],
  });
  click(m.criteria);
  click(m.open);
  expect(spies.criteria).toHaveBeenCalledTimes(2);
  expect(spies.open).toHaveBeenCalledWith(entry.runId, openSession);
});

it.each(["en", "es", "eu"] as const)(
  "preserves the complete accessible evidence presentation in %s",
  (locale) => {
    const controller = new ReviewedEvidenceController({ read: vi.fn() }, vi.fn());
    const render = () =>
      renderToStaticMarkup(
        <ReviewedEvidenceView locale={locale} controller={controller} openSession={vi.fn()} />,
      );
    const empty = render();
    controller.status = "ready";
    controller.response = page();
    const students = render();
    controller.response = page({ entries: [] });
    const noEvidence = render();
    const criteria = [
      { ...criterion, statement: "Frozen criterion" },
      { ...criterion, digest: `sha256:${"b".repeat(64)}`, statement: "Different frozen version" },
    ];
    controller.response = page({
      kind: "criteria",
      query: query({ kind: "criteria", studentId: "s1" }),
      entries: criteria,
    });
    const versions = render();
    const nodes = reviewElements(
      <ReviewedEvidenceView locale={locale} controller={controller} openSession={vi.fn()} />,
    ).filter((node) => node.type === "li");
    expect(new Set(nodes.map((node) => node.key)).size).toBe(2);
    controller.response = page({
      kind: "history",
      query: query({ kind: "history", studentId: "s1", criterion }),
      entries: [entry],
    });
    const history = render();
    expect(history).toContain(
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(
        new Date(entry.approvedAt),
      ),
    );
    controller.navigationBlocked = true;
    expect({
      empty,
      students,
      noEvidence,
      versions,
      history: history.replace(/(<time[^>]*>)[^<]+/g, "$1[localized approval time]"),
      blocked: render().replace(/(<time[^>]*>)[^<]+/g, "$1[localized approval time]"),
    }).toMatchSnapshot();
  },
);
