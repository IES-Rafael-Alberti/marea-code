import { newerEntry, olderEntry, rememberEntry } from "./history.js";
import { withdrawRetryOffers } from "./transcript.js";
import type {
  ConversationAction,
  ConversationLanguageChange,
  ConversationHistory,
  ConversationSnapshot,
  TurnFailureInfo,
  TurnFailureKind,
} from "../conversation-contracts.js";
import { type ApprovalAction } from "./approval.js";
import { localCommand } from "./commands.js";
import type { ParityCopy } from "./copy.js";
import type { ParityDecision, ParityEvent, SessionContext } from "./events.js";
import type { QuestionsAction } from "./questions.js";
import { applyApproval, applyEvent, applyQuestions, openSession } from "./session-state.js";
import { filterToolArguments } from "./tool.js";
import { finishAssistantText } from "./transcript.js";

const FAILURE_MESSAGES: Record<TurnFailureKind, (copy: ParityCopy) => string> = {
  "provider-interrupted": (copy) => copy.failure.providerInterrupted,
  "request-failed": (copy) => copy.failure.requestFailed,
  "session-unavailable": (copy) => copy.failure.sessionUnavailable,
  "deadline-exceeded": (copy) => copy.failure.deadlineExceeded,
  "budget-exhausted": (copy) => copy.failure.budgetExhausted,
  "concurrency-limited": (copy) => copy.failure.concurrencyLimited,
  "recovery-pending": (copy) => copy.failure.recoveryPending,
  unexpected: (copy) => copy.turn.driverFailed,
};

type FailedEvent = Extract<ParityEvent, { type: "turn-failed" }>;

function failedEvent(failure: TurnFailureInfo | undefined, copy: ParityCopy): FailedEvent {
  if (failure === undefined) {
    return {
      detail: "",
      message: copy.turn.driverFailed,
      recoverable: true,
      retryable: false,
      type: "turn-failed",
    };
  }
  return {
    detail:
      failure.kind === "provider-interrupted" && failure.hasPrefix && failure.retryable
        ? copy.failure.resumeDetail
        : failure.detail,
    message: FAILURE_MESSAGES[failure.kind](copy),
    recoverable: failure.recoverable,
    retryable: failure.retryable,
    type: "turn-failed",
  };
}

function approvalArguments(approval: NonNullable<ConversationSnapshot["approval"]>) {
  return {
    content: approval.content,
    filePath: approval.path,
    oldString: approval.arguments?.old_string,
    newString: approval.arguments?.new_string,
  };
}

export function createPresentation(
  context: SessionContext,
  copy: ParityCopy,
  dispatch: (action: ConversationAction) => void,
  history?: ConversationHistory,
  onLanguageCommand?: (
    copy: import("../conversation-contracts.js").ConversationCopy,
  ) => ConversationLanguageChange | Promise<ConversationLanguageChange | null> | null,
) {
  let state = applyEvent(openSession(history?.entries), { type: "session-started", context });
  let retryNoticeId: string | null = null;
  let previous: Omit<ConversationSnapshot, "status"> & { status?: ConversationSnapshot["status"] } =
    { approval: null, messages: [] };
  const notice = (text: string, tone: "plain" | "help" = "plain") => {
    state = {
      ...state,
      nextId: state.nextId + 1,
      transcript: [
        ...finishAssistantText(state.transcript),
        {
          id: `e${String(state.nextId)}`,
          kind: "notice",
          text,
          tone,
        },
      ],
    };
  };
  const syncActivity = (snapshot: ConversationSnapshot): void => {
    if (
      snapshot.status === "streaming" &&
      (previous.status !== "streaming" || snapshot.activity === "thinking")
    ) {
      state = {
        ...state,
        transcript: finishAssistantText(state.transcript),
        status: {
          ...state.status,
          activity: "thinking",
          toolName: "",
          hint: "turn",
          elapsedMs: 0,
        },
      };
    }
  };
  const syncMessages = (snapshot: ConversationSnapshot): void => {
    for (const [index, message] of snapshot.messages.entries()) {
      const prior = previous.messages[index];
      if (message.author === "student") {
        if (prior !== undefined) continue;
        state = {
          ...state,
          nextId: state.nextId + 1,
          transcript: [
            ...finishAssistantText(state.transcript),
            {
              id: `e${String(state.nextId)}`,
              kind: "user",
              text: message.text,
            },
          ],
        };
      } else {
        const text = message.text.slice(prior?.text.length ?? 0);
        if (text !== "") state = applyEvent(state, { type: "assistant-text", text });
      }
    }
  };
  const syncTools = (snapshot: ConversationSnapshot): void => {
    const previousTools = new Map(previous.tools?.map((tool) => [tool.callId, tool]));
    for (const tool of snapshot.tools ?? []) {
      const prior = previousTools.get(tool.callId);
      if (prior === undefined) {
        state = applyEvent(state, {
          arguments: filterToolArguments(tool.arguments),
          callId: tool.callId,
          name: tool.name,
          type: "tool-started",
        });
      }
      if (prior?.outcome == null && tool.outcome !== null) {
        state = applyEvent(state, {
          callId: tool.callId,
          failed: tool.outcome.failed,
          result: tool.outcome.result,
          type: "tool-finished",
        });
      }
    }
  };
  const toggleOutputs = (ids: readonly string[], expanded?: boolean): void => {
    state = {
      ...state,
      transcript: state.transcript.map((entry) =>
        entry.kind === "tool" && entry.row.outcome !== null && ids.includes(entry.id)
          ? { ...entry, row: { ...entry.row, expanded: expanded ?? !entry.row.expanded } }
          : entry,
      ),
    };
  };
  const retry = (): void => {
    const offered =
      state.transcript.findLast((entry) => entry.kind === "error")?.retryOffered === true;
    if (previous.status !== "failed" || !offered) {
      notice(copy.notices.noRetry);
      return;
    }
    state = { ...state, transcript: withdrawRetryOffers(state.transcript) };
    retryNoticeId = `e${String(state.nextId)}`;
    notice(copy.notices.retrying);
    dispatch({ type: "retry" });
  };
  const changeLanguage = (): void => {
    if (onLanguageCommand === undefined) return;
    const result = onLanguageCommand({
      parity: { copy, context, ...(history === undefined ? {} : { history }) },
    });
    void Promise.resolve(result).then((change) => {
      if (change === null) return;
      copy = change.copy.parity.copy;
      if (change.notice !== undefined) notice(change.notice);
    });
  };
  return {
    retry,
    toggleTool(id: string): void {
      toggleOutputs([id]);
    },
    toggleLastOutput(): string | null {
      const last = state.transcript.findLast(
        (entry) => entry.kind === "tool" && entry.row.outcome !== null,
      );
      if (last === undefined) notice(copy.notices.noOutputs);
      else toggleOutputs([last.id]);
      return last?.id ?? null;
    },
    toggleTurnOutputs(): string | null {
      const start = state.transcript.findLastIndex((entry) => entry.kind === "user");
      const tools = state.transcript
        .slice(start + 1)
        .filter((entry) => entry.kind === "tool")
        .filter((entry) => entry.row.outcome !== null);
      if (tools.length === 0) notice(copy.notices.noTurnOutputs);
      else
        toggleOutputs(
          tools.map((entry) => entry.id),
          tools.some((entry) => !entry.row.expanded),
        );
      return tools.at(-1)?.id ?? null;
    },
    recall(older: boolean, draft: string): string | null {
      const step = older ? olderEntry(state.history, draft) : newerEntry(state.history);
      state = { ...state, history: step.state };
      return step.text;
    },
    present(event: ParityEvent): void {
      state = applyEvent(state, event);
    },
    questions(action: QuestionsAction): ParityDecision | null {
      const step = applyQuestions(state, action);
      if (step === null) return null;
      state = step.state;
      return step.decision;
    },
    snapshot: () => state,
    sync(snapshot: ConversationSnapshot): void {
      syncActivity(snapshot);
      syncMessages(snapshot);
      syncTools(snapshot);
      if (snapshot.approval !== null && snapshot.approval !== previous.approval) {
        const approval = snapshot.approval;
        state = applyEvent(state, {
          type: "approval-requested",
          request: {
            arguments: approvalArguments(approval),
            interruptId: approval.approvalId ?? "",
            name: approval.toolName ?? "write_file",
            preview: `${approval.summary}\n${approval.path}`,
            warnings: approval.warnings ?? [],
          },
        });
      }
      if (snapshot.approval === null) {
        const step = applyApproval(state, { type: "cancel" });
        if (step !== null) state = step.state;
      }
      if (snapshot.questions !== undefined && snapshot.questions !== previous.questions)
        state = applyEvent(state, { type: "questions-asked", request: snapshot.questions });
      if (snapshot.questions === undefined) {
        const cancelled = applyQuestions(state, { type: "cancel" });
        if (cancelled !== null) state = cancelled.state;
      }
      const busy =
        snapshot.status === "streaming" ||
        snapshot.status === "approval" ||
        snapshot.status === "questions";
      state = { ...state, turnActive: busy };
      if (!busy) {
        state = {
          ...state,
          transcript: state.transcript
            .filter((entry) => entry.id !== retryNoticeId)
            .map((entry) =>
              entry.kind === "error" && !entry.retryOffered
                ? { ...entry, retryable: false }
                : entry,
            ),
        };
        retryNoticeId = null;
      }
      if (!busy) {
        state = {
          ...state,
          transcript: finishAssistantText(state.transcript),
          status: { ...state.status, activity: "ready", hint: "ready", elapsedMs: null },
        };
      }
      if (snapshot.status !== previous.status) {
        if (snapshot.status === "cancelled") {
          const cancelledPanel =
            state.transcript
              .slice(-1)
              .find(
                (entry) => entry.kind === "approval" && entry.approval.decision?.type === "cancel",
              ) !== undefined;
          if (!cancelledPanel) notice(copy.turn.interrupted);
        }
        if (snapshot.status === "failed") {
          state = applyEvent(state, failedEvent(snapshot.failure, copy));
        }
      }
      previous = snapshot;
    },
    approve(action: ApprovalAction): void {
      const step = applyApproval(state, action);
      if (step === null) return;
      state = step.state;
      if (step.decision?.type === "approve")
        dispatch({ type: "approve", interruptId: step.decision.interruptId });
      if (step.decision?.type === "reject")
        dispatch({
          type: "reject",
          interruptId: step.decision.interruptId,
          reason: step.decision.reason,
        });
      if (step.decision?.type === "cancel") dispatch({ type: "cancel" });
    },
    submit(text: string): boolean {
      const command = localCommand(text);
      if (command === "exit") {
        dispatch({ type: "exit" });
        return true;
      }
      if (command === "help") {
        notice(copy.help, "help");
        return true;
      }
      if (command === "details") {
        state = { ...state, detailedOutputs: !state.detailedOutputs };
        toggleOutputs(
          state.transcript.map((entry) => entry.id),
          state.detailedOutputs,
        );
        toggleOutputs(
          state.transcript
            .filter((entry) => entry.kind === "tool" && entry.row.outcome?.failed)
            .map((entry) => entry.id),
          true,
        );
        notice(state.detailedOutputs ? copy.notices.outputsDetailed : copy.notices.outputsCompact);
        return true;
      }
      if (command === "retry") {
        retry();
        return true;
      }
      if (command === "language") {
        changeLanguage();
        return true;
      }
      if (state.turnActive) {
        notice(copy.notices.draftKept);
        return false;
      }
      if (state.fatal || text.trim() === "" || text.length > 8192) return false;
      state = { ...state, history: rememberEntry(state.history, text.trim()) };
      history?.remember(text.trim());
      dispatch({ type: "submit", text });
      return true;
    },
    setCopy(next: ParityCopy): void {
      copy = next;
    },
  };
}

export type Presentation = ReturnType<typeof createPresentation>;
