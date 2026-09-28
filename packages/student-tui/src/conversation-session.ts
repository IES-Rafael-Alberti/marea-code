import type { SignalSource, StudentTuiExitReason, StudentTuiOutcome } from "./contracts.js";
import { attemptCleanup } from "./cleanup.js";
import type {
  ConversationAction,
  ConversationAttemptId,
  ConversationController,
  ConversationPendingTurn,
  ConversationSnapshot,
  ConversationTuiSession,
  ConversationView,
} from "./conversation-contracts.js";
import { createConversationController } from "./conversation-controller.js";

interface ConversationSessionOptions {
  readonly onMessage: (
    text: string,
    signal: AbortSignal,
    messageId: string,
    attemptId: ConversationAttemptId,
  ) => Promise<void>;
  readonly initialTurn?: ConversationPendingTurn | undefined;
  readonly nextMessageId?: (() => string) | undefined;
  readonly nextAttemptId?: (() => ConversationAttemptId) | undefined;
  readonly setExitCode: (code: number) => void;
  readonly signals: SignalSource;
  readonly view: ConversationView;
}

export interface ConversationSessionBinding {
  readonly session: ConversationTuiSession;
  readonly handleAction: (action: ConversationAction) => boolean;
}

type ConversationExitReason = Exclude<StudentTuiExitReason, "quit">;

const OUTCOMES: Readonly<Record<ConversationExitReason, StudentTuiOutcome>> = Object.freeze({
  closed: Object.freeze({ exitCode: 0, reason: "closed" }),
  sigint: Object.freeze({ exitCode: 130, reason: "sigint" }),
  sigterm: Object.freeze({ exitCode: 143, reason: "sigterm" }),
});

function initializeController(
  options: ConversationSessionOptions,
  onExit: () => void,
): ConversationController {
  try {
    return createConversationController({
      initialTurn: options.initialTurn,
      onExit,
      onMessage: options.onMessage,
      nextAttemptId: options.nextAttemptId,
      nextMessageId: options.nextMessageId,
      view: options.view,
    });
  } catch {
    attemptCleanup(() => {
      options.view.dispose();
    });
    throw new Error("Conversation TUI setup failed.");
  }
}

export function createConversationTuiSession(
  options: ConversationSessionOptions,
): ConversationSessionBinding {
  // The controller closes over this callback before the session finalizer can be constructed.
  // eslint-disable-next-line prefer-const
  let requestExit: () => void;
  const controller = initializeController(options, () => {
    requestExit();
  });
  const outcome = Promise.withResolvers<StudentTuiOutcome>();
  // Stryker disable next-line ArrayDeclaration: the empty cleanup registry has no observable alternative.
  const removals: (() => void)[] = [];
  let settled = false;

  const removeListeners = (): void => {
    for (const remove of removals) attemptCleanup(remove);
  };

  const finish = (reason: ConversationExitReason): boolean => {
    if (settled) return false;
    settled = true;
    attemptCleanup(() => {
      controller.dispose();
    });
    removeListeners();
    const selected = OUTCOMES[reason];
    attemptCleanup(() => {
      options.setExitCode(selected.exitCode);
    });
    outcome.resolve(selected);
    return true;
  };

  requestExit = () => {
    finish("sigint");
  };

  try {
    removals.push(options.signals.subscribe("SIGINT", () => finish("sigint")));
    removals.push(options.signals.subscribe("SIGTERM", () => finish("sigterm")));
  } catch {
    removeListeners();
    attemptCleanup(() => {
      controller.dispose();
    });
    throw new Error("Conversation TUI signal setup failed.");
  }

  const active = (operation: () => boolean): boolean => !settled && operation();
  const session: ConversationTuiSession = Object.freeze({
    appendAssistantText: (text: string, messageId?: string, attemptId?: ConversationAttemptId) =>
      active(() => controller.appendAssistantText(text, messageId, attemptId)),
    cancel: (messageId?: string, attemptId?: ConversationAttemptId) =>
      active(() => controller.cancel(messageId, attemptId)),
    close: () => finish("closed"),
    complete: (messageId?: string, attemptId?: ConversationAttemptId) =>
      active(() => controller.complete(messageId, attemptId)),
    fail: (messageId?: string, attemptId?: ConversationAttemptId) =>
      active(() => controller.fail(messageId, attemptId)),
    retry: () => active(() => controller.handle({ type: "retry" })),
    outcome: outcome.promise,
    requestQuestions(
      request: Parameters<ConversationController["requestQuestions"]>[0],
      messageId?: string,
      attemptId?: ConversationAttemptId,
    ) {
      return settled
        ? Promise.reject(new Error("The conversation is already closed."))
        : controller.requestQuestions(request, messageId, attemptId);
    },
    requestApproval(
      approval: Parameters<ConversationController["requestApproval"]>[0],
      messageId?: string,
      attemptId?: ConversationAttemptId,
    ) {
      return settled
        ? Promise.reject(new Error("The conversation is already closed."))
        : controller.requestApproval(approval, messageId, attemptId);
    },
    resumeTurn: () => active(() => controller.resumeTurn()),
    snapshot: (): ConversationSnapshot => controller.snapshot(),
    thinking: (messageId?: string, attemptId?: string) =>
      active(() => controller.thinking(messageId, attemptId)),
    toolFinished: (
      finish: Parameters<ConversationController["toolFinished"]>[0],
      messageId?: string,
      attemptId?: ConversationAttemptId,
    ) => active(() => controller.toolFinished(finish, messageId, attemptId)),
    toolStarted: (
      call: Parameters<ConversationController["toolStarted"]>[0],
      messageId?: string,
      attemptId?: ConversationAttemptId,
    ) => active(() => controller.toolStarted(call, messageId, attemptId)),
  });

  return Object.freeze({
    handleAction: (action: ConversationAction) => active(() => controller.handle(action)),
    session,
  });
}
