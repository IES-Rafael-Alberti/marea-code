import { describe, expect, it, vi } from "vitest";

import type {
  SignalSource,
  StudentTuiCopy,
  StudentTuiEnvironment,
  StudentTuiIntent,
  StudentTuiView,
} from "./contracts.js";
import { startStudentTuiWithPorts } from "./runtime.js";
import { StudentTuiStartupError } from "./startup-error.js";

const quietSignals: SignalSource = {
  subscribe(): () => void {
    return () => undefined;
  },
};

const copy: StudentTuiCopy = {
  controls: "controls",
  emptyResponse: "empty",
  errors: {
    nonInteractive: "noninteractive",
    rendererFailed: "renderer",
    unexpected: "unexpected",
  },
  statuses: {
    cancelled: "cancelled",
    complete: "complete",
    ready: "ready",
    streaming: "streaming",
  },
  title: "title",
};

function environment(interactive: boolean): StudentTuiEnvironment {
  return {
    interactive,
    setExitCode: vi.fn(),
    signals: quietSignals,
  };
}

function view(): StudentTuiView {
  return { dispose: vi.fn(), render: vi.fn() };
}

describe("startStudentTuiWithPorts", () => {
  it("refuses noninteractive terminals before creating a renderer", async () => {
    const factory = vi.fn();

    await expect(startStudentTuiWithPorts(copy, environment(false), factory)).rejects.toMatchObject(
      {
        code: "NON_INTERACTIVE",
        exitCode: 2,
        message: "Student TUI startup failed: NON_INTERACTIVE",
      },
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("maps renderer creation failures to a safe public error", async () => {
    await expect(
      startStudentTuiWithPorts(copy, environment(true), () =>
        Promise.reject(new Error("private renderer detail")),
      ),
    ).rejects.toEqual(new StudentTuiStartupError("RENDERER_FAILED"));
  });

  it("binds keyboard intents only after the session exists", async () => {
    let sendIntent: (intent: StudentTuiIntent) => void = () => undefined;
    const target = view();
    const targetEnvironment = environment(true);
    const session = await startStudentTuiWithPorts(copy, targetEnvironment, (_copy, onIntent) => {
      sendIntent = onIntent;
      onIntent("quit");
      return Promise.resolve(target);
    });

    sendIntent("quit");

    await expect(session.outcome).resolves.toEqual({ exitCode: 0, reason: "quit" });
    expect(vi.mocked(target.dispose)).toHaveBeenCalledOnce();
    expect(targetEnvironment.setExitCode).toHaveBeenCalledWith(0);
  });

  it("disposes a renderer when initial session rendering fails", async () => {
    const target: StudentTuiView = {
      dispose: vi.fn(),
      render(): void {
        throw new Error("native render detail");
      },
    };

    await expect(
      startStudentTuiWithPorts(copy, environment(true), () => Promise.resolve(target)),
    ).rejects.toMatchObject({ code: "RENDERER_FAILED" });
    expect(vi.mocked(target.dispose)).toHaveBeenCalledOnce();
  });
});
