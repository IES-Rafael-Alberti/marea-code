import { PARITY_TEST_COPY } from "../test-support/parity-copy.js";
import { describe, expect, it, vi } from "vitest";

import type { SignalSource, StudentTuiEnvironment } from "./contracts.js";
import type {
  ConversationAction,
  ConversationCopy,
  ConversationView,
} from "./conversation-contracts.js";
import { startConversationTuiWithPorts } from "./conversation-runtime.js";

const copy: ConversationCopy = {
  parity: {
    copy: PARITY_TEST_COPY,
    context: { cwd: "", branch: "", model: "", repositoryUrl: "" },
  },
};

const signals: SignalSource = {
  subscribe(): () => void {
    return () => undefined;
  },
};

function environment(interactive: boolean): StudentTuiEnvironment {
  return { interactive, setExitCode: vi.fn(), signals };
}

function view(): ConversationView {
  return { dispose: vi.fn(), render: vi.fn() };
}

describe("conversation TUI runtime", () => {
  it("refuses a noninteractive terminal before loading OpenTUI", async () => {
    const factory = vi.fn();

    await expect(
      startConversationTuiWithPorts(
        { copy, onMessage: () => Promise.resolve() },
        environment(false),
        factory,
      ),
    ).rejects.toMatchObject({ code: "NON_INTERACTIVE" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("connects view actions after initialization", async () => {
    let action: (value: ConversationAction) => void = () => undefined;
    const target = view();
    const session = await startConversationTuiWithPorts(
      { copy, onMessage: vi.fn(() => Promise.resolve()) },
      environment(true),
      (_copy, onAction) => {
        action = onAction;
        onAction({ type: "exit" });
        return Promise.resolve(target);
      },
    );

    action({ type: "exit" });

    await expect(session.outcome).resolves.toEqual({ exitCode: 130, reason: "sigint" });
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("forwards durable message and attempt id factories to the controller", async () => {
    const target = view();
    const action = vi.fn<(value: ConversationAction) => void>();
    const onMessage = vi.fn(() => Promise.resolve());
    const session = await startConversationTuiWithPorts(
      {
        copy,
        nextAttemptId: () => "attempt:one",
        nextMessageId: () => "message:one",
        onMessage,
      },
      environment(true),
      (_copy, onAction) => {
        action.mockImplementation(onAction);
        return Promise.resolve(target);
      },
    );

    action({ type: "submit", text: "Help" });
    expect(onMessage).toHaveBeenCalledWith(
      "Help",
      expect.any(AbortSignal),
      "message:one",
      "attempt:one",
    );
    session.close();
    await session.outcome;
  });

  it("passes an initial pending turn through before the caller resumes it", async () => {
    const target = view();
    const onMessage = vi.fn(() => Promise.resolve());
    const session = await startConversationTuiWithPorts(
      {
        copy,
        initialTurn: { assistantText: "Saved", messageId: "message:old", text: "Continue" },
        onMessage,
      },
      environment(true),
      () => Promise.resolve(target),
    );

    expect(session.snapshot().messages).toEqual([
      { author: "student", text: "Continue" },
      { author: "marea", text: "Saved" },
    ]);
    expect(session.resumeTurn()).toBe(true);
    expect(onMessage).toHaveBeenCalledWith(
      "Continue",
      expect.any(AbortSignal),
      "message:old",
      expect.any(String),
    );
    session.close();
    await session.outcome;
  });

  it("maps renderer and session setup failures to a safe startup error", async () => {
    await expect(
      startConversationTuiWithPorts(
        { copy, onMessage: () => Promise.resolve() },
        environment(true),
        () => Promise.reject(new Error("private native failure")),
      ),
    ).rejects.toMatchObject({ code: "RENDERER_FAILED" });

    const target: ConversationView = {
      dispose: vi.fn(),
      render(): void {
        throw new Error("private render failure");
      },
    };
    await expect(
      startConversationTuiWithPorts(
        { copy, onMessage: () => Promise.resolve() },
        environment(true),
        () => Promise.resolve(target),
      ),
    ).rejects.toMatchObject({ code: "RENDERER_FAILED" });
  });
});
