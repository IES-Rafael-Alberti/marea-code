import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConversationController } from "../conversation-controller.js";
import type { ConversationCopy, ConversationLanguageChange } from "../conversation-contracts.js";
import { createConversationView } from "./conversation-view.js";
import { PARITY_TEST_COPY } from "../../test-support/parity-copy.js";
import { LiveParityScreen } from "./parity/live-screen.js";
import { collectUnhandledRejections } from "../../test-support/unhandled-rejections.boundary.js";

afterEach(() => vi.useRealTimers());

describe("conversation OpenTUI view", () => {
  it("selects the live parity screen for application copy and reuses its transcript", async () => {
    vi.useFakeTimers();
    const render = vi.fn<(node: ReactNode) => void>();
    const onAction = vi.fn();
    const view = await createConversationView(
      {
        parity: {
          copy: PARITY_TEST_COPY,
          context: { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
        },
      },
      onAction,
      () => Promise.resolve({ dispose: vi.fn(), render }),
    );
    view.render({ approval: null, messages: [], status: "ready" });
    view.render({
      approval: null,
      messages: [{ author: "marea", text: "Hello" }],
      status: "streaming",
    });
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(render.mock.calls[0]?.[0]).toMatchObject({
      type: LiveParityScreen,
      props: { copy: PARITY_TEST_COPY, onAction },
    });
    const first = render.mock.calls[0]?.[0] as ReactElement<
      ComponentProps<typeof LiveParityScreen>
    >;
    const second = render.mock.calls[1]?.[0] as ReactElement<
      ComponentProps<typeof LiveParityScreen>
    >;
    expect(second.props.presentation).toBe(first.props.presentation);
    expect(second.props.presentation.snapshot().transcript.at(-1)).toMatchObject({
      kind: "assistant",
      text: "Hello",
    });
    expect(second.props.presentation.submit("/language")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    view.dispose();
  });
});

it("resolves the controller interrupt through the rendered parity presentation", async () => {
  const render = vi.fn<(node: ReactNode) => void>();
  const pendingTurn = Promise.withResolvers<undefined>();
  const view = await createConversationView(
    {
      parity: {
        copy: PARITY_TEST_COPY,
        context: { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
      },
    },
    (action) => {
      controller.handle(action);
    },
    () => Promise.resolve({ dispose: vi.fn(), render }),
  );
  const controller = createConversationController({
    onMessage: () => pendingTurn.promise,
    onExit: vi.fn(),
    view,
  });
  try {
    controller.handle({ type: "submit", text: "Help" });
    const reply = controller.requestQuestions({
      interruptId: "q1",
      questions: [{ text: "Pick", choices: ["One", "Two"], required: true }],
    });
    const screen = render.mock.calls.at(-1)?.[0] as ReactElement<
      ComponentProps<typeof LiveParityScreen>
    >;
    expect(screen.type).toBe(LiveParityScreen);
    expect(screen.props.presentation.snapshot().pendingId).toBe("e2");
    expect(screen.props.presentation.questions({ type: "type", value: "2" })).toBeNull();
    const decision = screen.props.presentation.questions({ type: "submit" });
    expect(decision).toEqual({ type: "answers", interruptId: "q1", values: ["Two"] });
    if (decision?.type !== "answers") throw new Error("Expected answers");
    screen.props.onAction(decision);
    await expect(reply).resolves.toEqual({ type: "answers", values: ["Two"] });
    expect(screen.props.presentation.snapshot().pendingId).toBeNull();
    expect(screen.props.presentation.questions({ type: "submit" })).toBeNull();
    expect(controller.handle(decision)).toBe(false);
  } finally {
    controller.dispose();
    pendingTurn.resolve(undefined);
  }
});

it.each([undefined, false, true])(
  "forwards mouse preference and cancels scheduled renders on dispose (%s)",
  async (mouse) => {
    vi.useFakeTimers();
    const render = vi.fn();
    const dispose = vi.fn();
    const createHost = vi.fn(() => Promise.resolve({ render, dispose }));
    const view = await createConversationView(
      {
        ...(mouse === undefined ? {} : { mouse }),
        parity: {
          copy: PARITY_TEST_COPY,
          context: { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
        },
      },
      vi.fn(),
      createHost,
    );
    expect(createHost).toHaveBeenCalledExactlyOnceWith({ mouse: mouse ?? true });
    view.render({ approval: null, messages: [], status: "streaming" });
    view.dispose();
    vi.advanceTimersByTime(100);
    expect(render).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  },
);

/** A live parity view after its first scheduled render. */
async function liveView(onLanguageCommand?: Parameters<typeof createConversationView>[3]) {
  vi.useFakeTimers();
  const render = vi.fn<(node: ReactNode) => void>();
  const view = await createConversationView(
    {
      parity: {
        copy: PARITY_TEST_COPY,
        context: { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
      },
    },
    vi.fn(),
    () => Promise.resolve({ dispose: vi.fn(), render }),
    onLanguageCommand,
  );
  view.render({ approval: null, messages: [], status: "ready" });
  vi.advanceTimersByTime(100);
  const screen = () =>
    render.mock.calls.at(-1)?.[0] as ReactElement<ComponentProps<typeof LiveParityScreen>>;
  return { view, render, screen };
}

it("refreshes the rendered copy after a language command without losing the presentation", async () => {
  const changedCopy = {
    ...PARITY_TEST_COPY,
    help: "Laguntza",
    commands: { ...PARITY_TEST_COPY.commands, language: "Aldatu hizkuntza" },
  };
  const onLanguageCommand = vi.fn<(current: ConversationCopy) => ConversationLanguageChange | null>(
    () => ({
      copy: {
        parity: {
          copy: changedCopy,
          context: { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
        },
      },
      notice: "Hizkuntza aldatu da",
    }),
  );
  const { view, render, screen } = await liveView(onLanguageCommand);
  const first = screen();
  expect(first.props.presentation.submit("/language")).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(render).toHaveBeenCalledTimes(2);
  const second = render.mock.calls.at(-1)?.[0] as ReactElement<
    ComponentProps<typeof LiveParityScreen>
  >;
  expect(second.props.copy).toBe(changedCopy);
  expect(second.props.presentation).toBe(first.props.presentation);
  expect(second.props.presentation.submit("/help")).toBe(true);
  expect(second.props.presentation.snapshot().transcript.at(-1)).toMatchObject({
    text: "Laguntza",
  });
  onLanguageCommand.mockImplementationOnce(() => null);
  expect(
    await collectUnhandledRejections(() => {
      expect(second.props.presentation.submit("/language")).toBe(true);
    }),
  ).toEqual([]);
  expect(onLanguageCommand.mock.calls.at(-1)?.[0].parity.copy).toBe(changedCopy);
  expect(render).toHaveBeenCalledTimes(2);
  if (view.setCopy === undefined) throw new Error("Missing copy setter");
  view.setCopy({
    parity: {
      copy: PARITY_TEST_COPY,
      context: { cwd: "/project", branch: "", model: "", repositoryUrl: "" },
    },
  });
  expect(render).toHaveBeenCalledTimes(3);
  const reset = render.mock.calls.at(-1)?.[0] as ReactElement<
    ComponentProps<typeof LiveParityScreen>
  >;
  expect(reset.props.copy).toBe(PARITY_TEST_COPY);
  expect(reset.props.presentation).toBe(first.props.presentation);
  expect(reset.props.presentation.submit("/help")).toBe(true);
  expect(reset.props.presentation.snapshot().transcript.at(-1)).toMatchObject({
    text: PARITY_TEST_COPY.help,
  });
  view.dispose();
});

it("keeps the language command local when the view composes no language handler", async () => {
  const { view, render, screen } = await liveView();
  expect(
    await collectUnhandledRejections(() => {
      expect(screen().props.presentation.submit("/language")).toBe(true);
    }),
  ).toEqual([]);
  expect(render).toHaveBeenCalledTimes(1);
  view.dispose();
});
