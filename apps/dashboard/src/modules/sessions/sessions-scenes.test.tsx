import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CanonicalRunEventSchema,
  ClassSessionsResponseSchema,
  RunHistoryResponseSchema,
} from "@marea/protocol";
import { SessionsModule } from "./sessions-module.js";
import { SessionsController } from "./sessions-controller.js";
import { sessionsMessages } from "./sessions-messages.js";
import { evaluationClientFixture, SESSIONS, HISTORY } from "../evaluation/evaluation.fixture.js";

it.each(["en", "es"] as const)(
  "preserves the complete %s classroom copy and readable presentation",
  async (locale) => {
    expect(sessionsMessages(locale)).toMatchSnapshot("complete classroom copy");
    const page = ClassSessionsResponseSchema.parse({
      ...SESSIONS,
      kind: "class-sessions-response",
      runs: SESSIONS.runs.map((run) => ({ ...run, classId: "class:one" })),
    });
    const client = { ...evaluationClientFixture(), classes: vi.fn().mockResolvedValue(page) };
    client.history.mockResolvedValue(
      RunHistoryResponseSchema.parse({
        ...HISTORY,
        events: [
          {
            eventType: "student-message",
            eventId: "event:one",
            sequence: 1,
            occurredAt: "2026-09-19T08:00:00.000Z",
            content: "How should I test an empty list?",
          },
        ],
        throughSequence: 1,
        nextSequence: null,
        afterSequence: 0,
      }),
    );
    const controller = new SessionsController(
      client,
      { publish: vi.fn(), query: vi.fn() },
      vi.fn(),
    );
    const html = () =>
      renderToStaticMarkup(
        <SessionsModule
          locale={locale}
          controller={controller}
          classes={[{ classId: "class:one", displayName: "Physics" }]}
        />,
      );
    expect(html()).toMatchSnapshot("connecting and empty");
    await controller.start();
    expect(html()).toMatchSnapshot("unselected session list");
    await controller.select("run:one");
    expect(html()).toMatchSnapshot("conversation and draft");
    controller.state = {
      ...controller.state,
      connection: "stale",
      catchingUp: true,
      moreBusy: true,
    };
    expect(html()).toMatchSnapshot("stale readable evidence and pending history");
    controller.dispose();
  },
);
it("shows current project context, turn accounting and separate internal diagnostics", () => {
  const controller = new SessionsController(
    { ...evaluationClientFixture(), classes: vi.fn() },
    { publish: vi.fn(), query: vi.fn() },
    vi.fn(),
  );
  controller.state = {
    ...controller.state,
    runId: "run:one",
    events: RunHistoryResponseSchema.parse({
      ...HISTORY,
      events: [
        {
          eventType: "project-context",
          eventId: "event:project",
          sequence: 1,
          occurredAt: "2026-09-20T10:00:00.000Z",
          cwd: "/project",
          branch: "main",
          repositoryUrl: "",
        },
        {
          eventType: "turn-ended",
          eventId: "event:turn",
          sequence: 2,
          occurredAt: "2026-09-20T10:00:01.000Z",
          messageId: "message:one",
          state: "completed",
        },
      ],
      throughSequence: 2,
      nextSequence: null,
    }).events,
  };
  const html = renderToStaticMarkup(
    <SessionsModule locale="en" controller={controller} classes={[]} />,
  );
  expect(html).toContain('class="project-context">/project · main');
  expect(html).toContain('class="turn-summary"');
  expect(html).toContain('class="session-diagnostics"');
  controller.dispose();
});

it("keeps session diagnostics separate from both conversational roles and finds context after other events", () => {
  const controller = new SessionsController(
    { ...evaluationClientFixture(), classes: vi.fn() },
    { publish: vi.fn(), query: vi.fn() },
    vi.fn(),
  );
  const payloads = [
    { eventType: "student-message", content: "student-only-prose", messageId: "message:one" },
    { eventType: "project-context", cwd: "/project", branch: "", repositoryUrl: "" },
    { eventType: "assistant-message", content: "assistant-only-prose", messageId: "message:one" },
    {
      eventType: "model-diagnostic",
      requestId: "request:one",
      phase: "response",
      status: "failed",
      content: "internal-route-code",
      truncated: false,
    },
    { eventType: "turn-ended", messageId: "message:one", state: "completed" },
  ];
  controller.state = {
    ...controller.state,
    runId: "run:one",
    events: payloads.map((payload, index) =>
      CanonicalRunEventSchema.parse({
        ...payload,
        eventId: `event:${String(index)}`,
        sequence: index + 1,
        occurredAt: "2026-09-20T10:00:00.000Z",
      }),
    ),
  };
  const html = renderToStaticMarkup(
    <SessionsModule locale="en" controller={controller} classes={[]} />,
  );
  expect(html).toContain('<p class="project-context">/project</p>');
  expect(html).toContain("student-only-prose");
  expect(html).toContain("assistant-only-prose");
  const diagnostics = html.slice(html.indexOf('<details class="session-diagnostics">'));
  expect(diagnostics).not.toContain("student-only-prose");
  expect(diagnostics).not.toContain("assistant-only-prose");
  expect(diagnostics).toContain("internal-route-code");
  expect(diagnostics).toContain("run:one");
  controller.dispose();
});

it("renders each parallel read beside its own output, retaining the original timestamps", () => {
  const controller = new SessionsController(
    { ...evaluationClientFixture(), classes: vi.fn() },
    { publish: vi.fn(), query: vi.fn() },
    vi.fn(),
  );
  const events = [
    {
      eventType: "tool-started",
      callId: "list",
      name: "marea_list_project",
      target: "/",
      arguments: "{}",
      truncated: false,
    },
    {
      eventType: "tool-started",
      callId: "read",
      name: "marea_read_project",
      target: "/exercise.md",
      arguments: "{}",
      truncated: false,
    },
    {
      eventType: "tool-finished",
      callId: "read",
      result: "exercise-output",
      failed: false,
      truncated: false,
    },
    {
      eventType: "tool-finished",
      callId: "list",
      result: "directory-output",
      failed: false,
      truncated: false,
    },
  ].map((payload, index) =>
    CanonicalRunEventSchema.parse({
      ...payload,
      eventId: `event:${String(index)}`,
      sequence: index + 1,
      messageId: "message:parallel",
      occurredAt: `2026-09-21T17:16:25.00${String(index)}Z`,
    }),
  );
  controller.state = { ...controller.state, runId: "run:one", events };
  const html = renderToStaticMarkup(
    <SessionsModule locale="es" controller={controller} classes={[]} />,
  );
  const conversation = html.slice(0, html.indexOf('<details class="session-diagnostics">'));
  expect(conversation.match(/class="conversation-tool-group"/gu)).toHaveLength(2);
  const labels = [
    "marea_list_project",
    "directory-output",
    "marea_read_project",
    "exercise-output",
  ];
  const positions = labels.map((label) => conversation.indexOf(label));
  expect(positions.every((index) => index >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  for (const event of events) expect(conversation).toContain(`dateTime="${event.occurredAt}"`);
  expect(controller.state.events).toBe(events);
  controller.dispose();
});
