import type { ConversationTuiSession } from "@marea/student-tui";

import type {
  ApprovalPrompt,
  AuthenticationInput,
  AuthenticationReason,
  StudentInterface,
  StudentViewEvent,
} from "./contracts.js";

export interface AuthenticationPrompt {
  authenticate(reason: AuthenticationReason): Promise<AuthenticationInput>;
}

export type StudentConversationPort = Pick<
  ConversationTuiSession,
  | "requestQuestions"
  | "appendAssistantText"
  | "cancel"
  | "complete"
  | "requestApproval"
  | "thinking"
  | "toolFinished"
  | "toolStarted"
>;

export interface ConversationStudentInterfaceOptions {
  readonly authentication: AuthenticationPrompt;
  readonly conversation: StudentConversationPort;
  readonly executeWarning?: string | undefined;
  readonly getExecuteWarning?: (() => string) | undefined;
}

export interface ConversationExitSignal {
  readonly onExit: () => void;
  readonly wait: () => Promise<void>;
}

export function adaptConversationTuiSession(
  session: StudentConversationPort,
): StudentConversationPort {
  return Object.freeze({
    appendAssistantText: session.appendAssistantText.bind(session),
    cancel: session.cancel.bind(session),
    complete: session.complete.bind(session),
    requestApproval: session.requestApproval.bind(session),
    ...(session.requestQuestions === undefined
      ? {}
      : { requestQuestions: session.requestQuestions.bind(session) }),
    thinking: session.thinking.bind(session),
    toolFinished: session.toolFinished.bind(session),
    toolStarted: session.toolStarted.bind(session),
  });
}

export function createConversationStudentInterface(
  options: ConversationStudentInterfaceOptions,
): StudentInterface {
  return Object.freeze({
    authenticate: (reason: AuthenticationReason) => options.authentication.authenticate(reason),
    askQuestions: async (
      request: import("@marea/deepagents-adapter").QuestionRequest &
        import("./contracts.js").TurnAttemptIdentity,
    ) => {
      if (options.conversation.requestQuestions === undefined)
        throw new Error("The conversation does not support questions.");
      return options.conversation.requestQuestions(
        { interruptId: request.interruptId, questions: request.questions },
        request.messageId,
        request.attemptId,
      );
    },
    confirmWrite: async (prompt: ApprovalPrompt) => {
      return options.conversation.requestApproval(
        {
          approvalId: prompt.approvalId,
          toolName: prompt.toolName ?? "write_file",
          arguments: prompt.arguments,
          warnings:
            prompt.toolName === "execute"
              ? [
                  options.getExecuteWarning?.() ??
                    options.executeWarning ??
                    "El comando se ejecutará con tus permisos del sistema; puede modificar archivos fuera del proyecto.",
                ]
              : [],
          content: prompt.content,
          path: prompt.path,
          summary: prompt.summary,
        },
        prompt.messageId,
        prompt.attemptId,
      );
    },
    present(event: StudentViewEvent): void {
      if (event.type === "assistant-text") {
        options.conversation.appendAssistantText(event.text, event.messageId, event.attemptId);
      } else if (event.type === "thinking") {
        options.conversation.thinking(event.messageId, event.attemptId);
      } else if (event.type === "tool-started") {
        options.conversation.toolStarted(
          {
            arguments: event.arguments,
            callId: event.callId,
            name: event.name,
          },
          event.messageId,
          event.attemptId,
        );
      } else if (event.type === "tool-finished") {
        options.conversation.toolFinished(
          {
            callId: event.callId,
            failed: event.failed,
            result: event.result,
          },
          event.messageId,
          event.attemptId,
        );
      } else if (event.type === "turn-completed") {
        options.conversation.complete(event.messageId, event.attemptId);
      } else {
        options.conversation.cancel(event.messageId, event.attemptId);
      }
    },
  });
}

export function createConversationExitSignal(): ConversationExitSignal {
  const exit = Promise.withResolvers<undefined>();
  return Object.freeze({
    onExit(): void {
      exit.resolve(undefined);
    },
    wait: () => exit.promise,
  });
}
