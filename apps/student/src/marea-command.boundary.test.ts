import { createTranslator } from "@marea/i18n";
import { ApprovalIdSchema, STARTUP_MESSAGE_ID } from "@marea/protocol";
import type { ConversationTuiOptions } from "@marea/student-tui";
import { describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({ created: [] as object[] }));
vi.mock("./external-authorization.boundary.js", async (original) => {
  const actual = await original<typeof import("./external-authorization.boundary.js")>();
  return {
    ...actual,
    createLoopbackAuthorization: (
      options: Parameters<typeof actual.createLoopbackAuthorization>[0],
    ) => {
      loopback.created.push(options);
      return actual.createLoopbackAuthorization(options);
    },
  };
});

import type { ProductionStudentCompositionOptions } from "./composition.js";
import type { ApprovalPrompt, StudentViewEvent } from "./contracts.js";
import {
  createBindableConversationPort,
  executeMareaCommand,
  MAREA_CLIENT_VERSION,
  type MareaCommandRuntime,
} from "./marea-command.boundary.js";

import {
  commandOptions,
  conversationSession,
  testConversationRuntime,
} from "./command-options.fixture.js";

describe("marea command", () => {
  it.each([
    { arguments: ["--help"], expected: "Usage: marea", status: 0, stream: "writes" },
    { arguments: ["-h"], expected: "Usage: marea", status: 0, stream: "writes" },
    { arguments: ["--version"], expected: MAREA_CLIENT_VERSION, status: 0, stream: "writes" },
    { arguments: ["-v"], expected: MAREA_CLIENT_VERSION, status: 0, stream: "writes" },
    { arguments: ["--no-mouse", "extra"], expected: "Usage: marea", status: 2, stream: "errors" },
    { arguments: ["--server"], expected: "Usage: marea", status: 2, stream: "errors" },
    { arguments: ["--provider"], expected: "Usage: marea", status: 2, stream: "errors" },
    { arguments: ["--help", "extra"], expected: "Usage: marea", status: 2, stream: "errors" },
    { arguments: ["--version", "extra"], expected: "Usage: marea", status: 2, stream: "errors" },
    { arguments: ["feedback", "--ack"], expected: "Usage: marea", status: 2, stream: "errors" },
    {
      arguments: ["feedback", "--wrong", "notice:1"],
      expected: "Usage: marea",
      status: 2,
      stream: "errors",
    },
    {
      arguments: ["feedback", "--ack", "bad/id"],
      expected: "Usage: marea",
      status: 2,
      stream: "errors",
    },
    {
      arguments: ["feedback", "--ack", "notice:1", "extra"],
      expected: "Usage: marea",
      status: 2,
      stream: "errors",
    },
  ])("handles $arguments without starting the application", async (scenario) => {
    const options = commandOptions({ arguments: scenario.arguments });
    const createApplication = vi.fn();

    await expect(
      executeMareaCommand(options, {
        createApplication,
        nextAttemptId: vi.fn(),
        nextMessageId: vi.fn(),
        readGitContext: () => ({ branch: "", repositoryUrl: "" }),
        startConversation: vi.fn(),
      }),
    ).resolves.toBe(scenario.status);
    expect(options[scenario.stream as "errors" | "writes"].join("")).toContain(scenario.expected);
    expect(createApplication).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("requires a configured teacher server: %s", async (serverUrl) => {
    const options = commandOptions({ serverUrl });

    await expect(
      executeMareaCommand(options, {
        createApplication: vi.fn(),
        nextAttemptId: vi.fn(),
        nextMessageId: vi.fn(),
        readGitContext: () => ({ branch: "", repositoryUrl: "" }),
        startConversation: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(options.errors).toEqual(["Marea does not have a teacher server address yet.\n"]);
  });

  it.each([{ arguments: [] }, { arguments: ["--no-mouse"] }])(
    "runs the production orchestration through the conversation boundary: $arguments",
    async ({ arguments: arguments_ }) => {
      const exit = Promise.withResolvers<{ readonly exitCode: 0; readonly reason: "closed" }>();
      const session = conversationSession(exit.promise);
      const controller = {
        close: vi.fn(() => Promise.resolve()),
        sendMessage: vi.fn(() => Promise.resolve()),
        pendingTurn: vi.fn(() => Promise.resolve(null)),
        start: vi.fn(() =>
          Promise.resolve({
            classroomDisplayName: "Physics",
            projectDisplayName: "project-one",
            runId: "run:1",
            snapshot: { modelAlias: "marea" },
          }),
        ),
      };
      const compositions: ProductionStudentCompositionOptions[] = [];
      const conversationStarts: ConversationTuiOptions[] = [];
      const dispose = vi.fn();
      const runtime: MareaCommandRuntime = {
        createApplication(options) {
          compositions.push(options);
          return Promise.resolve({ controller, dispose });
        },
        nextAttemptId: () => "attempt:one",
        nextMessageId: () => "message:1",
        readGitContext: () => ({ branch: "trunk", repositoryUrl: "https://example.invalid/r.git" }),
        startConversation(options) {
          conversationStarts.push(options);
          return Promise.resolve(session);
        },
      };
      const options = commandOptions({
        serverUrl: "  https://teacher.example  ",
        arguments: arguments_,
      });
      const execution = executeMareaCommand(options, runtime);
      await vi.waitFor(() => {
        expect(conversationStarts).toHaveLength(1);
      });
      const composition = compositions[0];
      const conversationOptions = conversationStarts[0];
      if (composition === undefined || conversationOptions === undefined) {
        throw new Error("Fixture not ready.");
      }

      expect(conversationOptions.copy.mouse).toBe(!arguments_.includes("--no-mouse"));
      expect(loopback.created.at(-1)).toEqual({
        translator: options.translator,
        output: options.output,
      });
      expect(composition.externalAuthorization).toBeDefined();
      const studentInterface = composition.studentInterface;
      const identity = { attemptId: "attempt:one", messageId: "message:retry" } as const;
      const assistantEvent = {
        attemptId: "attempt:one",
        messageId: "message:retry",
        text: "Hello",
        type: "assistant-text",
      } satisfies StudentViewEvent;
      studentInterface.present(assistantEvent);
      const completedEvent = {
        attemptId: "attempt:one",
        messageId: "message:retry",
        type: "turn-completed",
      } satisfies StudentViewEvent;
      studentInterface.present(completedEvent);
      const cancelledEvent = {
        attemptId: "attempt:one",
        messageId: "message:retry",
        type: "turn-cancelled",
      } satisfies StudentViewEvent;
      studentInterface.present(cancelledEvent);
      const approvalPrompt: ApprovalPrompt = {
        approvalId: ApprovalIdSchema.parse("approval:1"),
        content: "Proposed notes",
        ...identity,
        path: "notes.md",
        summary: "Create notes",
      };
      await expect(studentInterface.confirmWrite(approvalPrompt)).resolves.toBe("approved");
      await expect(
        studentInterface.confirmWrite({ ...approvalPrompt, toolName: "execute" }),
      ).resolves.toBe("approved");
      expect(session.requestApproval).toHaveBeenLastCalledWith(
        expect.objectContaining({
          warnings: [
            "The command runs with your system permissions and may modify files outside the project.",
          ],
        }),
        "message:retry",
        "attempt:one",
      );
      const signal = new AbortController().signal;
      await conversationOptions.onMessage(
        "Explain momentum",
        signal,
        "message:retry",
        "attempt:one",
      );
      await conversationOptions.onMessage(
        "Explain momentum",
        signal,
        "message:retry",
        "attempt:two",
      );
      exit.resolve({ exitCode: 0, reason: "closed" });

      await expect(execution).resolves.toBe(0);
      expect(composition).toMatchObject({
        clientVersion: MAREA_CLIENT_VERSION,
        projectRoot: "/courses/physics/project-one",
        serverUrl: "https://teacher.example",
      });
      expect(composition.stateDirectory).toMatch(
        /^\/home\/student\/\.marea\/student\/[a-f0-9]{64}$/u,
      );
      expect(controller.start).toHaveBeenCalledWith("project-one");
      expect(controller.sendMessage).toHaveBeenNthCalledWith(
        1,
        "message:retry",
        "Explain momentum",
        signal,
        "attempt:one",
      );
      expect(controller.sendMessage).toHaveBeenNthCalledWith(
        2,
        "message:retry",
        "Explain momentum",
        signal,
        "attempt:two",
      );
      expect(conversationOptions.nextMessageId).toBe(runtime.nextMessageId);
      expect(conversationOptions.nextAttemptId).toBe(runtime.nextAttemptId);
      expect(conversationOptions.copy.parity.context).toEqual({
        branch: "trunk",
        cwd: "/courses/physics/project-one",
        model: "marea",
        repositoryUrl: "https://example.invalid/r.git",
      });
      const languageChange = await conversationOptions.onLanguageCommand?.(
        conversationOptions.copy,
      );
      expect(languageChange?.copy.parity.copy.commands.language).toBe(
        "aldatu interfazearen hizkuntza",
      );
      expect(languageChange?.notice).toBe("Interfazearen hizkuntza: Euskara");
      const automaticLanguageChange = await conversationOptions.onLanguageCommand?.(
        languageChange?.copy ?? conversationOptions.copy,
      );
      expect(automaticLanguageChange?.copy.parity.copy.commands.language).toBe(
        "aldatu interfazearen hizkuntza",
      );
      expect(conversationOptions).not.toHaveProperty("initialTurn");
      expect(session.resumeTurn).not.toHaveBeenCalled();
      expect(controller.close).toHaveBeenCalledWith("student-exit");
      expect(session.appendAssistantText).toHaveBeenCalledWith(
        "Hello",
        "message:retry",
        "attempt:one",
      );
      expect(session.complete).toHaveBeenCalledWith("message:retry", "attempt:one");
      expect(session.cancel).toHaveBeenCalledWith("message:retry", "attempt:one");
      expect(session.requestApproval).toHaveBeenCalledWith(
        {
          approvalId: approvalPrompt.approvalId,
          toolName: "write_file",
          warnings: [],
          content: "Proposed notes",
          path: "notes.md",
          summary: "Create notes",
        },
        "message:retry",
        "attempt:one",
      );
      expect(session.close).toHaveBeenCalledOnce();
      expect(controller.pendingTurn).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { startup: false, failed: false },
    { startup: true, failed: false },
    { startup: false, failed: true },
    { startup: true, failed: true },
  ])(
    "hydrates startup=$startup failed=$failed and resumes only unfailed turns",
    async ({ startup, failed }) => {
      const exit = Promise.withResolvers<{ readonly exitCode: 0; readonly reason: "closed" }>();
      const order: string[] = [];
      const session = conversationSession(exit.promise);
      session.resumeTurn.mockImplementation(() => {
        order.push("resume");
        return true;
      });
      const pendingTurn = {
        ...(failed
          ? {
              failure: {
                code: "budget-exhausted",
                detail: "No budget",
                hasPrefix: true,
                kind: "budget-exhausted" as const,
                recoverable: true,
                retryable: false,
              },
            }
          : {}),
        ...(startup ? { kind: "startup" as const } : {}),
        assistantText: "Saved answer prefix",
        messageId: startup ? STARTUP_MESSAGE_ID : "message:old",
        text: startup ? "" : "Continue my work",
      };
      const controller = {
        close: vi.fn(() => Promise.resolve()),
        pendingTurn: vi.fn(() => Promise.resolve(pendingTurn)),
        sendMessage: vi.fn(() => Promise.resolve()),
        sendStartup: vi.fn(() => Promise.resolve()),
        start: vi.fn(() => {
          order.push("start");
          return Promise.resolve({});
        }),
      };
      let startedOptions: ConversationTuiOptions | undefined;
      const runtime: MareaCommandRuntime = {
        createApplication: () => Promise.resolve({ controller, dispose: vi.fn() }),
        ...testConversationRuntime((options) => {
          order.push("tui");
          startedOptions = options;
          return Promise.resolve(session);
        }),
      };

      const execution = executeMareaCommand(commandOptions(), runtime);
      await vi.waitFor(() => {
        expect(startedOptions).toBeDefined();
      });
      if (startedOptions === undefined) throw new Error("The TUI was not started.");
      const signal = new AbortController().signal;
      await startedOptions.onMessage(
        pendingTurn.text,
        signal,
        pendingTurn.messageId,
        "attempt:new",
      );
      if (startup) {
        expect(controller.sendStartup).toHaveBeenCalledExactlyOnceWith(signal, "attempt:new");
        expect(controller.sendMessage).not.toHaveBeenCalled();
        await startedOptions.onMessage("Real student", signal, "message:new", "attempt:student");
        expect(controller.sendMessage).toHaveBeenCalledWith(
          "message:new",
          "Real student",
          signal,
          "attempt:student",
        );
        Reflect.deleteProperty(controller, "sendStartup");
        await expect(
          startedOptions.onMessage("", signal, STARTUP_MESSAGE_ID, "attempt:missing"),
        ).rejects.toThrow("The controller does not support tutor startup.");
      } else {
        expect(controller.sendStartup).not.toHaveBeenCalled();
        expect(controller.sendMessage).toHaveBeenCalledWith(
          pendingTurn.messageId,
          pendingTurn.text,
          signal,
          "attempt:new",
        );
      }
      exit.resolve({ exitCode: 0, reason: "closed" });

      await expect(execution).resolves.toBe(0);
      expect(order).toEqual(failed ? ["start", "tui"] : ["start", "tui", "resume"]);
      expect(controller.pendingTurn).toHaveBeenCalledOnce();
      expect(startedOptions.initialTurn).toEqual(pendingTurn);
      expect(session.resumeTurn).toHaveBeenCalledTimes(failed ? 0 : 1);
    },
  );

  it("fails the command safely when a pending turn cannot be resumed", async () => {
    const session = conversationSession();
    session.resumeTurn.mockReturnValue(false);
    const close = vi.fn(() => Promise.resolve());
    const controller = {
      close,
      pendingTurn: vi.fn(() =>
        Promise.resolve({ assistantText: "Saved", messageId: "message:old", text: "Continue" }),
      ),
      sendMessage: vi.fn(() => Promise.resolve()),
      start: vi.fn(() => Promise.resolve({})),
    };

    await expect(
      executeMareaCommand(commandOptions(), {
        createApplication: () => Promise.resolve({ controller, dispose: vi.fn() }),
        nextAttemptId: () => "attempt:new",
        nextMessageId: () => "attempt:new",
        readGitContext: () => ({ branch: "", repositoryUrl: "" }),
        startConversation: () => Promise.resolve(session),
      }),
    ).resolves.toBe(1);
    expect(close).toHaveBeenCalledWith("fatal-error");
  });

  it.each([
    { expectedRoot: "/private/marea", stateRoot: " /private/marea " },
    { expectedRoot: "/home/student/.marea", stateRoot: " " },
  ])(
    "uses state root '$stateRoot' and a safe display name at a filesystem root",
    async ({ expectedRoot, stateRoot }) => {
      const session = conversationSession();
      const start = vi.fn(() => Promise.resolve({}));
      const compositions: ProductionStudentCompositionOptions[] = [];
      const options = commandOptions({ currentDirectory: "/", stateRoot });

      await expect(
        executeMareaCommand(options, {
          createApplication(value) {
            compositions.push(value);
            return Promise.resolve({
              controller: {
                close: vi.fn(() => Promise.resolve()),
                pendingTurn: vi.fn(() => Promise.resolve(null)),
                sendMessage: vi.fn(() => Promise.resolve()),
                start,
              },
              dispose: vi.fn(),
            });
          },
          nextAttemptId: vi.fn(),
          nextMessageId: vi.fn(),
          readGitContext: () => ({ branch: "", repositoryUrl: "" }),
          startConversation: () => Promise.resolve(session),
        }),
      ).resolves.toBe(0);
      expect(start).toHaveBeenCalledWith("project");
      expect(compositions[0]?.stateDirectory.startsWith(`${expectedRoot}/student/`)).toBe(true);
    },
  );

  it("disposes an application when startup fails before the TUI exists", async () => {
    const dispose = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    const options = commandOptions();

    await expect(
      executeMareaCommand(options, {
        createApplication: () =>
          Promise.resolve({
            controller: {
              close,
              pendingTurn: vi.fn(() => Promise.resolve(null)),
              sendMessage: vi.fn(() => Promise.resolve()),
              start: () => Promise.reject(new Error("startup failed")),
            },
            dispose,
          }),
        nextAttemptId: vi.fn(),
        nextMessageId: vi.fn(),
        readGitContext: () => ({ branch: "", repositoryUrl: "" }),
        startConversation: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(close).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns a localized safe error without leaking an internal failure", async () => {
    const options = commandOptions({ translator: createTranslator("es") });

    await expect(
      executeMareaCommand(options, {
        createApplication: () => Promise.reject(new Error("secret provider key")),
        nextAttemptId: vi.fn(),
        nextMessageId: vi.fn(),
        readGitContext: () => ({ branch: "", repositoryUrl: "" }),
        startConversation: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(options.errors).toEqual([
      "Marea no ha podido iniciarse. Inténtalo de nuevo.\nCódigo de diagnóstico: local-state/unexpected. Inclúyelo al comunicar el problema.\n",
    ]);
    expect(options.errors.join("")).not.toContain("secret provider key");
  });
});

it("forwards generic thinking through the bound conversation port", () => {
  const port = createBindableConversationPort();
  expect(() => port.thinking()).toThrow("The conversation interface is not ready.");
  const session = conversationSession();
  port.bind(session);
  expect(port.thinking("message", "attempt")).toBe(true);
  expect(session.thinking).toHaveBeenCalledExactlyOnceWith("message", "attempt");
});
