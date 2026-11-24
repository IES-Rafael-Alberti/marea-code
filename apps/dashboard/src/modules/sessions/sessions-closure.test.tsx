import { isValidElement, type ReactElement } from "react";
import { ClassSessionsResponseSchema } from "@marea/protocol";
import { expect, it, vi } from "vitest";

import { createRunClosureClient } from "../run-closure/run-closure-client.boundary.js";
import { EndClassSessionsControl, EndSessionControl } from "../run-closure/run-closure-controls.js";
import { evaluationClientFixture, SESSIONS } from "../evaluation/evaluation.fixture.js";
import { ClassClosure, SelectedClosure } from "./sessions-closure.js";
import { SessionsController } from "./sessions-controller.js";

function setup(withClosures: boolean) {
  const closures = createRunClosureClient(vi.fn());
  const client = {
    ...evaluationClientFixture(),
    classes: vi.fn(),
    ...(withClosures ? { closures } : {}),
  };
  const controller = new SessionsController(client, { publish: vi.fn(), query: vi.fn() }, vi.fn());
  const page = ClassSessionsResponseSchema.parse({
    ...SESSIONS,
    kind: "class-sessions-response",
    runs: [
      { ...SESSIONS.runs[0], classId: "class:one", state: "active", closedAt: null },
      { ...SESSIONS.runs[0], runId: "run:two", classId: "class:one", state: "closed" },
    ],
  });
  const refresh = vi.spyOn(controller, "refresh").mockResolvedValue();
  const [active, closed] = page.runs;
  if (active === undefined || closed === undefined) throw new Error("Expected two runs");
  return { closures, controller, page, refresh, active, closed };
}

function element(node: ReturnType<typeof ClassClosure>): ReactElement<{
  client: object;
  locale: string;
  classId?: string;
  runs?: readonly object[];
  run?: object;
  onClosed: () => void;
}> {
  if (!isValidElement(node)) throw new Error("Expected a control");
  return node as never;
}

it("offers to end all open sessions of the chosen class, listing only the open ones shown", () => {
  const { closures, controller, page, refresh, active } = setup(true);
  const node = ClassClosure({ controller, locale: "en", classId: "class:one", runs: page.runs });
  const control = element(node);
  expect(control.type).toBe(EndClassSessionsControl);
  expect(control.props).toMatchObject({
    client: closures,
    locale: "en",
    classId: "class:one",
    runs: [active],
  });
  control.props.onClosed();
  expect(refresh).toHaveBeenCalledOnce();
  const none = element(ClassClosure({ controller, locale: "en", classId: "class:one", runs: [] }));
  expect(none.props.runs).toEqual([]);
});

it("offers no class-wide ending without a chosen class, or without a closing client", () => {
  const withClient = setup(true);
  expect(
    ClassClosure({
      controller: withClient.controller,
      locale: "en",
      classId: null,
      runs: withClient.page.runs,
    }),
  ).toBeNull();
  const without = setup(false);
  expect(
    ClassClosure({
      controller: without.controller,
      locale: "en",
      classId: "class:one",
      runs: without.page.runs,
    }),
  ).toBeNull();
});

it("offers to end the selected session only while it is open", () => {
  const { closures, controller, refresh, active, closed } = setup(true);
  const node = SelectedClosure({ controller, locale: "en", selected: active });
  const control = element(node);
  expect(control.type).toBe(EndSessionControl);
  expect(control.props).toMatchObject({ client: closures, locale: "en", run: active });
  // Keyed by the run, so a dialog never carries over to the next selected session.
  expect(control.key).toBe(active.runId);
  control.props.onClosed();
  expect(refresh).toHaveBeenCalledOnce();
  expect(SelectedClosure({ controller, locale: "en", selected: closed })).toBeNull();
  expect(SelectedClosure({ controller, locale: "en", selected: null })).toBeNull();
  expect(
    SelectedClosure({ controller: setup(false).controller, locale: "en", selected: active }),
  ).toBeNull();
});

it("exposes the closing client of its history client", () => {
  const { closures, controller } = setup(true);
  expect(controller.closures).toBe(closures);
  expect(setup(false).controller.closures).toBeUndefined();
});
