import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticePanel } from "./notice-panel.js";
import { NoticeController } from "./notice-controller.js";
import { sessionsMessages } from "./sessions-messages.js";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";
import { TeacherNoticeStatusSchema } from "@marea/protocol";

it.each(["en", "es"] as const)("renders and routes the %s notice outbox states", (locale) => {
  const controller = new NoticeController("run:one", { publish: vi.fn(), query: vi.fn() }, vi.fn());
  const m = sessionsMessages(locale);
  const send = vi.spyOn(controller, "send").mockResolvedValue();
  const refresh = vi.spyOn(controller, "refresh").mockResolvedValue();
  const render = () => <NoticePanel controller={controller} messages={m} />;
  expect(renderToStaticMarkup(render())).toMatchSnapshot("empty composer");
  const initial = reviewElements(render());
  initial
    .find((element) => element.type === "textarea")
    ?.props.onChange?.({ currentTarget: { value: "Keep this draft" } });
  expect(controller.state.draft).toBe("Keep this draft");
  reviewButton(initial, m.send).props.onClick?.();
  expect(send).toHaveBeenCalledOnce();
  controller.state = { ...controller.state, uncertain: true, error: true, busy: true };
  expect(renderToStaticMarkup(render())).toMatchSnapshot("uncertain busy composer");
  const uncertain = reviewElements(render());
  expect(uncertain.find((element) => element.type === "textarea")?.props.disabled).toBe(true);
  expect(reviewButton(uncertain, m.retry).props.disabled).toBe(true);
  expect(renderToStaticMarkup(render())).toContain(m.uncertain);
  expect(renderToStaticMarkup(render())).toContain(m.error);
  reviewButton(uncertain, m.reconcile).props.onClick?.();
  expect(refresh).toHaveBeenCalledOnce();
  controller.state = { ...controller.state, busy: false };
  expect(
    reviewElements(render()).find((element) => element.type === "textarea")?.props.disabled,
  ).toBe(true);
  const publication = TeacherNoticeStatusSchema.parse({
    notice: {
      noticeId: "event:notice",
      runId: "run:one",
      source: "teacher-message",
      teacherDisplayName: "Teacher",
      text: "A hint",
      createdAt: "2026-09-19T08:00:00.000Z",
    },
    acknowledgedAt: null,
  });
  controller.state = {
    ...controller.state,
    uncertain: false,
    error: false,
    busy: false,
    publication,
  };
  expect(renderToStaticMarkup(render())).toMatchSnapshot("published");
  expect(renderToStaticMarkup(render())).toContain(m.published);
  expect(renderToStaticMarkup(render())).not.toContain("textarea");
  controller.state = {
    ...controller.state,
    publication: { ...publication, acknowledgedAt: "2026-09-19T08:01:00.000Z" },
  };
  expect(renderToStaticMarkup(render())).toMatchSnapshot("received");
  expect(renderToStaticMarkup(render())).toContain(m.received);
  reviewButton(reviewElements(render()), m.newMessage).props.onClick?.();
  expect(controller.state.publication).toBeNull();
  controller.dispose();
});
