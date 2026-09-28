import { createQuestionChannel } from "./question-channel.js";
import type { QuestionsRequest } from "./parity/questions.js";
import { trackTurnOperation } from "./turn-failure.boundary.js";
import {
  finishTool,
  startTool,
  withFailure,
  withoutStaleQuestions,
} from "./conversation-snapshot.js";
import type {
  ConversationAction,
  ConversationApproval,
  ConversationApprovalDecision,
  ConversationAttemptId,
  ConversationController,
  ConversationControllerOptions,
  ConversationMessage,
  ConversationMessageId,
  ConversationPendingTurn,
  ConversationSnapshot,
  ConversationToolCall,
  ConversationToolFinish,
  ConversationToolStart,
  TurnFailureInfo,
} from "./conversation-contracts.js";

const MAX_MESSAGE_LENGTH = 8_192;
type TurnPhase = "active" | "cancelled" | "completed" | "failed";

interface ActiveTurn {
  readonly abortController: AbortController;
  readonly attemptId: ConversationAttemptId;
  readonly messageId: ConversationMessageId;
  readonly text: string;
  phase: TurnPhase;
  settled: boolean;
  tools: readonly ConversationToolCall[];
}

interface FailedTurn {
  readonly messageId: ConversationMessageId;
  readonly text: string;
}

interface PendingApproval {
  readonly messageId: ConversationMessageId;
  readonly resolve: (decision: ConversationApprovalDecision) => void;
}

function appendMessage(
  messages: readonly ConversationMessage[],
  message: ConversationMessage,
): readonly ConversationMessage[] {
  return Object.freeze([...messages, Object.freeze(message)]);
}

function initialSnapshot(initialTurn: ConversationPendingTurn | undefined): ConversationSnapshot {
  const messages: ConversationMessage[] = [];
  if (initialTurn !== undefined) {
    if (initialTurn.kind !== "startup")
      messages.push({ author: "student", text: initialTurn.text });
    if (initialTurn.assistantText.length > 0) {
      messages.push({ author: "marea", text: initialTurn.assistantText });
    }
  }
  return Object.freeze({
    approval: null,
    messages: Object.freeze(messages.map((message) => Object.freeze(message))),
    ...(initialTurn?.failure === undefined ? {} : { failure: initialTurn.failure }),
    status:
      initialTurn?.failure !== undefined
        ? "failed"
        : initialTurn === undefined
          ? "ready"
          : "streaming",
  });
}

export function createConversationController(
  options: ConversationControllerOptions,
): ConversationController {
  let active = true;
  let exitRequested = false;
  let nextGeneratedMessageId = 0;
  let nextGeneratedAttemptId = 0;
  let turn: ActiveTurn | null = null;
  let failedTurn: FailedTurn | null =
    options.initialTurn?.failure === undefined
      ? null
      : { messageId: options.initialTurn.messageId, text: options.initialTurn.text };
  let pendingResume: ConversationPendingTurn | null =
    options.initialTurn?.failure === undefined ? (options.initialTurn ?? null) : null;
  let pendingApproval: PendingApproval | null = null;
  let current = initialSnapshot(options.initialTurn);
  const questions = createQuestionChannel();

  const nextMessageId = (): ConversationMessageId => {
    nextGeneratedMessageId += 1;
    return options.nextMessageId?.() ?? `message:${String(nextGeneratedMessageId)}`;
  };

  const nextAttemptId = (): ConversationAttemptId => {
    nextGeneratedAttemptId += 1;
    return options.nextAttemptId?.() ?? `attempt:${String(nextGeneratedAttemptId)}`;
  };

  const update = (snapshot: ConversationSnapshot): boolean => {
    if (snapshot.status !== "questions") questions.cancel();
    current = Object.freeze(withoutStaleQuestions(snapshot));
    options.view.render(current);
    return true;
  };

  const resolveApproval = (
    decision: ConversationApprovalDecision,
    status: ConversationSnapshot["status"],
    failure: TurnFailureInfo | undefined,
  ): boolean => {
    if (pendingApproval === null) return false;
    const pending = pendingApproval;
    pendingApproval = null;
    pending.resolve(decision);
    return update(withFailure({ ...current, approval: null, status }, failure));
  };

  const settleTurn = (settledTurn: ActiveTurn): void => {
    // The submission barrier keeps this turn installed until its operation
    // settles, so a settled turn cannot be replaced before this callback.
    if (
      settledTurn.settled &&
      (settledTurn.phase === "cancelled" ||
        settledTurn.phase === "completed" ||
        settledTurn.phase === "failed")
    ) {
      turn = null;
    }
  };

  const markFailed = (failed: ActiveTurn, failure: TurnFailureInfo | undefined): void => {
    if (failed.phase !== "active") {
      // A terminal notification can race with the onMessage promise rejection.
      // Still release the slot once that promise has settled, but never replace
      // the already-visible cancelled/ready/failed status.
      settleTurn(failed);
      return;
    }
    failed.phase = "failed";
    failedTurn = { messageId: failed.messageId, text: failed.text };
    // An unclassified rejection carries no failure key; the presentation
    // renders its generic message and the key stays absent (no stale data).
    const snapshot = withFailure({ ...current, approval: null, status: "failed" }, failure);
    if (pendingApproval?.messageId === failed.messageId) {
      resolveApproval("rejected", "failed", failure);
    } else {
      update(snapshot);
    }
    settleTurn(failed);
  };

  const runTurn = (
    text: string,
    messageId: ConversationMessageId,
    appendStudent: boolean,
  ): boolean => {
    const activeTurn: ActiveTurn = {
      abortController: new AbortController(),
      attemptId: nextAttemptId(),
      messageId,
      phase: "active",
      settled: false,
      text,
      // A new attempt shows only its own tool rows.
      tools: [],
    };
    turn = activeTurn;
    failedTurn = null;
    const messages = appendStudent
      ? appendMessage(current.messages, { author: "student", text })
      : current.messages;
    update({ approval: null, messages, status: "streaming" });

    let operation: Promise<void>;
    try {
      operation = options.onMessage(
        text,
        activeTurn.abortController.signal,
        messageId,
        activeTurn.attemptId,
      );
    } catch {
      operation = Promise.reject(new Error());
    }
    trackTurnOperation(
      operation,
      () => {
        activeTurn.settled = true;
        settleTurn(activeTurn);
      },
      (failure) => {
        activeTurn.settled = true;
        markFailed(activeTurn, failure);
      },
    );
    return true;
  };

  const submit = (text: string): boolean => {
    const normalized = text.trim();
    if (normalized === "/exit") return exit();
    if (normalized === "/retry") return retry();
    if (
      !active ||
      exitRequested ||
      pendingResume !== null ||
      turn !== null ||
      normalized.length === 0 ||
      normalized.length > MAX_MESSAGE_LENGTH
    )
      return false;
    return runTurn(normalized, nextMessageId(), true);
  };

  const retry = (): boolean => {
    if (!active) return false;
    // Only a failed snapshot carries a failure; starting a turn clears it.
    if (current.failure?.retryable !== true) return false;
    if (turn !== null) return false;
    // Every failed snapshot is created together with a retryable turn.
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    const retryable = failedTurn as FailedTurn;
    return runTurn(retryable.text, retryable.messageId, false);
  };

  const resumeTurn = (): boolean => {
    if (!active) return false;
    if (pendingResume === null) return false;
    const pending = pendingResume;
    pendingResume = null;
    return runTurn(pending.text, pending.messageId, false);
  };

  const matchesTurn = (
    candidate: ActiveTurn | null,
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): candidate is ActiveTurn =>
    candidate?.phase === "active" &&
    (messageId === undefined || candidate.messageId === messageId) &&
    (attemptId === undefined || candidate.attemptId === attemptId);

  const cancel = (
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): boolean => {
    if (!active || !matchesTurn(turn, messageId, attemptId)) return false;
    const cancelledTurn = turn;
    cancelledTurn.phase = "cancelled";
    failedTurn = null;
    cancelledTurn.abortController.abort();
    if (!resolveApproval("rejected", "cancelled", undefined)) {
      update({ ...current, approval: null, status: "cancelled" });
    }
    settleTurn(cancelledTurn);
    // The turn remains installed until its onMessage promise settles. This is
    // the submission barrier that prevents overlap with a cancelled stream.
    return true;
  };

  function exit(): boolean {
    if (!active || exitRequested) return false;
    exitRequested = true;
    cancel();
    options.onExit();
    return true;
  }

  const complete = (
    messageId?: ConversationMessageId,
    attemptId?: ConversationAttemptId,
  ): boolean => {
    const completedTurn = turn;
    if (!matchesTurn(completedTurn, messageId, attemptId)) return false;
    completedTurn.phase = "completed";
    failedTurn = null;
    if (!resolveApproval("rejected", "ready", undefined)) {
      update({ ...current, approval: null, status: "ready" });
    }
    settleTurn(completedTurn);
    // Completion uses the same settlement barrier as cancellation and failure.
    // The slot remains occupied until the operation's promise settles.
    return true;
  };

  const fail = (messageId?: ConversationMessageId, attemptId?: ConversationAttemptId): boolean => {
    const failed = turn;
    if (!matchesTurn(failed, messageId, attemptId)) return false;
    markFailed(failed, undefined);
    return true;
  };

  options.view.render(current);

  return Object.freeze({
    appendAssistantText(
      text: string,
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ): boolean {
      const currentTurn = turn;
      if (!matchesTurn(currentTurn, messageId, attemptId) || text.length === 0) return false;
      const last = current.messages.at(-1);
      const messages =
        last?.author === "marea"
          ? Object.freeze([
              ...current.messages.slice(0, -1),
              Object.freeze({ author: "marea" as const, text: last.text + text }),
            ])
          : appendMessage(current.messages, { author: "marea", text });
      return update({ ...current, activity: undefined, messages });
    },
    cancel,
    complete,
    dispose(): boolean {
      if (!active) return false;
      cancel();
      active = false;
      options.view.dispose();
      return true;
    },
    fail,
    handle(action: ConversationAction): boolean {
      if (action.type === "submit") return submit(action.text);
      if (action.type === "retry") return retry();
      if (action.type === "cancel") return cancel();
      if (action.type === "exit") {
        return exit();
      }
      if (action.type === "approve" || action.type === "reject") {
        if (action.interruptId !== undefined && action.interruptId !== current.approval?.approvalId)
          return false;
        return resolveApproval(
          action.type === "approve"
            ? "approved"
            : action.reason === undefined
              ? "rejected"
              : { decision: "rejected", reason: action.reason.slice(0, 2048) },
          "streaming",
          undefined,
        );
      }
      if (!questions.answer(action.interruptId, action.values)) return false;
      return update({ ...current, status: "streaming" });
    },
    requestQuestions(
      request: QuestionsRequest,
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ) {
      if (
        !matchesTurn(turn, messageId, attemptId) ||
        current.status === "approval" ||
        current.status === "questions"
      )
        return Promise.reject(new Error("The conversation cannot request questions now."));
      const result = questions.request(request);
      update({ ...current, questions: request, status: "questions" });
      return result;
    },
    requestApproval(
      approval: ConversationApproval,
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ): Promise<ConversationApprovalDecision> {
      const currentTurn = turn;
      if (!matchesTurn(currentTurn, messageId, attemptId)) {
        return Promise.reject(new Error("The conversation cannot request an approval now."));
      }
      if (pendingApproval !== null || current.status === "questions") {
        return Promise.reject(new Error("The conversation cannot request an approval now."));
      }
      const result = Promise.withResolvers<ConversationApprovalDecision>();
      pendingApproval = { messageId: currentTurn.messageId, resolve: result.resolve };
      update({ ...current, approval: Object.freeze(approval), status: "approval" });
      return result.promise;
    },
    resumeTurn,
    snapshot: () => current,
    thinking(messageId?: ConversationMessageId, attemptId?: ConversationAttemptId): boolean {
      if (!matchesTurn(turn, messageId, attemptId)) return false;
      return update({ ...current, activity: "thinking" });
    },
    toolFinished(
      finish: ConversationToolFinish,
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ): boolean {
      if (!matchesTurn(turn, messageId, attemptId)) return false;
      turn.tools = finishTool(turn.tools, finish);
      return update({ ...current, activity: undefined, tools: turn.tools });
    },
    toolStarted(
      call: ConversationToolStart,
      messageId?: ConversationMessageId,
      attemptId?: ConversationAttemptId,
    ): boolean {
      if (!matchesTurn(turn, messageId, attemptId)) return false;
      turn.tools = startTool(turn.tools, call);
      return update({ ...current, activity: undefined, tools: turn.tools });
    },
  });
}
