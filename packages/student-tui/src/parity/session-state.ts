import { approvalReducer, openApproval, type ApprovalAction } from "./approval.js";
import type { ParityDecision, ParityEvent } from "./events.js";
import { openHistory, type HistoryState } from "./history.js";
import { openQuestions, questionsReducer, type QuestionsAction } from "./questions.js";
import { INITIAL_STATUS, type StatusState } from "./status.js";
import {
  appendAssistantText,
  openAssistant,
  finishAssistantText,
  finishTool,
  withdrawRetryOffers,
  type Transcript,
} from "./transcript.js";

/**
 * The session as the student sees it.
 *
 * Everything the screen shows is derived from this value, and every change to
 * it is one reducer step, so a stale event or a late key cannot leave the
 * conversation in a state no sequence of actions could reach.
 */

export interface SessionState {
  /** True until the session has started and the composer is usable. */
  readonly starting: boolean;
  readonly detailedOutputs: boolean;
  /** True once a failure has made the session unusable. */
  readonly fatal: boolean;
  readonly history: HistoryState;
  /** The next entry id; entries are numbered so that keys stay stable. */
  readonly nextId: number;
  /** The transient toast, cleared by whatever shows it. */
  readonly notification: string | null;
  /** The entry currently holding the agent up, if any. */
  readonly pendingId: string | null;
  readonly status: StatusState;
  readonly transcript: Transcript;
  readonly turnActive: boolean;
}

export function openSession(entries: readonly string[] = []): SessionState {
  return {
    detailedOutputs: false,
    fatal: false,
    history: openHistory(entries),
    nextId: 0,
    notification: null,
    pendingId: null,
    starting: true,
    status: INITIAL_STATUS,
    transcript: [],
    turnActive: true,
  };
}

function identify(state: SessionState): { readonly id: string; readonly nextId: number } {
  return { id: `e${String(state.nextId)}`, nextId: state.nextId + 1 };
}

function running(state: SessionState, status: Partial<StatusState>): SessionState {
  return { ...state, status: { ...state.status, elapsedMs: 0, ...status } };
}

function started(state: SessionState, event: Extract<ParityEvent, { type: "session-started" }>) {
  const { id, nextId } = identify(state);
  return running(
    {
      ...state,
      nextId,
      starting: false,
      transcript: [...state.transcript, { context: event.context, id, kind: "banner" }],
    },
    {
      activity: "reviewing",
      branch: event.context.branch,
      hint: "turn",
      model: event.context.model,
    },
  );
}

function assistantText(state: SessionState, text: string): SessionState {
  const open = openAssistant(state.transcript);
  const { id, nextId } = identify(state);
  const transcript = appendAssistantText(state.transcript, id, text);
  // An id is only spent when a new entry was started.
  return running(
    { ...state, nextId: open === null ? nextId : state.nextId, transcript },
    { activity: "responding" },
  );
}

function reasoning(state: SessionState, text: string): SessionState {
  const { id, nextId } = identify(state);
  return running(
    {
      ...state,
      nextId,
      transcript: [...finishAssistantText(state.transcript), { id, kind: "reasoning", text }],
    },
    { activity: "thinking" },
  );
}

function toolStarted(
  state: SessionState,
  event: Extract<ParityEvent, { type: "tool-started" }>,
): SessionState {
  const { id, nextId } = identify(state);
  const row = {
    call: { arguments: event.arguments, callId: event.callId, name: event.name },
    expanded: false,
    outcome: null,
  };
  return running(
    {
      ...state,
      nextId,
      transcript: [...finishAssistantText(state.transcript), { id, kind: "tool", row }],
    },
    { activity: "tool", toolName: event.name },
  );
}

function interrupt(
  state: SessionState,
  entry: (id: string) => Transcript[number],
  status: Partial<StatusState>,
): SessionState {
  const { id, nextId } = identify(state);
  return {
    ...state,
    nextId,
    pendingId: id,
    status: { ...state.status, elapsedMs: null, ...status },
    transcript: [...finishAssistantText(state.transcript), entry(id)],
  };
}

function failed(
  state: SessionState,
  event: Extract<ParityEvent, { type: "turn-failed" }>,
): SessionState {
  const { id, nextId } = identify(state);
  const transcript = withdrawRetryOffers(finishAssistantText(state.transcript));
  return {
    ...state,
    fatal: !event.recoverable,
    nextId,
    transcript: [
      ...transcript,
      {
        detail: event.detail,
        id,
        kind: "error",
        message: event.message,
        retryOffered: event.retryable,
        retryable: event.retryable,
      },
    ],
  };
}

/** Folds one runtime event into the session. */
export function applyEvent(state: SessionState, event: ParityEvent): SessionState {
  switch (event.type) {
    case "session-started":
      return started(state, event);
    case "assistant-text":
      return assistantText(state, event.text);
    case "reasoning":
      return reasoning(state, event.text);
    case "tool-started":
      return toolStarted(state, event);
    case "tool-finished":
      return running(
        {
          ...state,
          transcript: finishTool(
            state.transcript,
            event.callId,
            { failed: event.failed, result: event.result },
            state.detailedOutputs,
          ),
        },
        { activity: "thinking" },
      );
    case "approval-requested":
      return interrupt(
        state,
        (id) => ({ approval: openApproval(event.request), id, kind: "approval" }),
        { activity: "waitingApproval", hint: "approval" },
      );
    case "questions-asked":
      return interrupt(
        state,
        (id) => ({ id, kind: "questions", questions: openQuestions(event.request) }),
        { activity: "waitingAnswer", hint: "questions" },
      );
    case "turn-failed":
      return failed(state, event);
    default:
      return running(
        { ...state, transcript: finishAssistantText(state.transcript) },
        { activity: "finishing" },
      );
  }
}

export interface PendingStep {
  /** The decision to hand back to the agent, or null while still deciding. */
  readonly decision: ParityDecision | null;
  readonly state: SessionState;
}

/** The entry the agent is waiting on, when it is of the kind asked for. */
function pendingEntry(state: SessionState): Transcript[number] | null {
  return state.transcript.find((item) => item.id === state.pendingId) ?? null;
}

function afterDecision(
  state: SessionState,
  entry: Transcript[number],
  next: Transcript[number],
  decision: ParityDecision | null,
): PendingStep {
  const transcript = state.transcript.map((item) => (item.id === entry.id ? next : item));
  if (decision === null) return { decision: null, state: { ...state, transcript } };
  return {
    decision,
    state: {
      ...state,
      pendingId: null,
      status: { ...state.status, activity: "thinking", elapsedMs: 0, hint: "turn" },
      transcript,
    },
  };
}

/** Applies an approval action to the pending approval, if that is what it is. */
export function applyApproval(state: SessionState, action: ApprovalAction): PendingStep | null {
  const entry = pendingEntry(state);
  if (entry?.kind !== "approval") return null;
  const approval = approvalReducer(entry.approval, action);
  if (approval === entry.approval) return null;
  const { interruptId } = entry.approval.request;
  const made = approval.decision;
  const decision: ParityDecision | null =
    made === null
      ? null
      : made.type === "approve"
        ? { interruptId, type: "approve" }
        : made.type === "reject"
          ? { interruptId, reason: made.reason, type: "reject" }
          : { type: "cancel" };
  return afterDecision(state, entry, { ...entry, approval }, decision);
}

/** Applies a questions action to the pending question set, if that is what it is. */
export function applyQuestions(state: SessionState, action: QuestionsAction): PendingStep | null {
  const entry = pendingEntry(state);
  if (entry?.kind !== "questions") return null;
  const questions = questionsReducer(entry.questions, action);
  if (questions === entry.questions) return null;
  const { interruptId } = entry.questions.request;
  const made = questions.decision;
  const decision: ParityDecision | null =
    made === null
      ? null
      : made.type === "answers"
        ? { interruptId, type: "answers", values: made.values }
        : { type: "cancel" };
  return afterDecision(state, entry, { ...entry, questions }, decision);
}
