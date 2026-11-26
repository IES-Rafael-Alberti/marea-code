import { createSocraticGate } from "./socratic-gate.boundary.js";
import { createCompactionMiddleware } from "./compaction.boundary.js";
import { createControlledTools } from "./controlled-tools.boundary.js";
import {
  createQuestionTools,
  questionInterrupts,
  QUESTION_TOOL_NAME,
} from "./questions.boundary.js";
import { createReviewChecks } from "./argument-checks.boundary.js";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { type BaseMessage, type BaseMessageChunk } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import * as z from "zod";

import {
  AgentAdapterError,
  type AgentEvent,
  type AgentModel,
  type AgentRecovery,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type ApprovalDecision,
  type ApprovalTurn,
  type MessageIdentity,
  type MessageTurn,
  type MareaGatewayModelOptions,
} from "./contracts.js";
import {
  assertPendingReview,
  assertRecoveredReview,
  parseApprovalEvent,
  pendingApproval,
} from "./approval-state.boundary.js";
import { resolveCheckpoint } from "./checkpoint.boundary.js";
import { MareaGatewayChatModel } from "./gateway-model.boundary.js";
import { registerMareaProfile } from "./harness-profile.js";
import { createReadOnlyStartupMiddleware, createReadOnlyTools } from "./read-tools.boundary.js";
import { createTurnInput } from "./turn-input.boundary.js";
import { createUnknownToolMiddleware } from "./unknown-tool.boundary.js";
import { createBatchRejections } from "./batch-rejections.boundary.js";
import { type ToolLifecycleEvent } from "./tool-events.boundary.js";
import {
  cancelTurnWith,
  continuationConfig,
  emptyBranchConfig,
  invalidReplayPrefix,
  isCompletedGraphState,
  recordTurnWith,
  recoverGraphTurn,
  recoveryAfterPrefix,
} from "./recovery-state.boundary.js";
import { beginContinuation } from "./continuation.boundary.js";
import {
  diagnosticCauseFor,
  normalizeDiagnosticCause,
  safelyRecordTurn,
  upstreamFailure,
} from "./upstream-failure.boundary.js";
import type { SupersededText } from "./superseded-text.js";
import { withUnansweredInputs } from "./unanswered-inputs.boundary.js";

export { assertPendingReview, parseApprovalEvent };
export { diagnosticCauseFor, normalizeDiagnosticCause };

interface UpstreamRun {
  readonly messages: AsyncIterable<{ readonly text: AsyncIterable<string> }>;
  readonly output: PromiseLike<unknown>;
}

const modelRegistry = new WeakMap<AgentModel, BaseLanguageModel<BaseMessageChunk>>();
const sessionIdSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const messageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export function createMareaGatewayModel(options: MareaGatewayModelOptions): AgentModel {
  return registerModel(new MareaGatewayChatModel(options));
}

export function bindTestModel(model: BaseLanguageModel<BaseMessageChunk>): AgentModel {
  return registerModel(model);
}

function registerModel(model: BaseLanguageModel<BaseMessageChunk>): AgentModel {
  const handle: AgentModel = Object.freeze({ kind: "marea-agent-model" });
  modelRegistry.set(handle, model);
  return handle;
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const model = modelRegistry.get(options.model);
  const checkpointer = resolveCheckpoint(options.checkpoint);
  if (model === undefined || checkpointer === undefined) {
    throw invalidDependency("Use adapter-created model and checkpoint handles.");
  }
  registerMareaProfile();
  // Tool rows are ephemeral interface state: they drain into the running
  // stream and are never journaled, so recovery replays text and approvals.
  const pendingToolEvents: ToolLifecycleEvent[] = [];
  const reportToolEvent = (event: ToolLifecycleEvent): void => {
    pendingToolEvents.push(event);
  };
  const drainToolEvents = (): readonly ToolLifecycleEvent[] => pendingToolEvents.splice(0);
  const effectTools = options.effectTools ?? [];
  const gate = createSocraticGate(options.socratic);
  const effects = [options.approvalTool, ...effectTools];
  const checks = createReviewChecks(effects, gate);
  const controlled = createControlledTools(effects, reportToolEvent, checks.noReview);
  const readers = options.readOnlyTools ?? [];
  const tools = [
    ...(options.readOnly === true ? [] : controlled.tools),
    ...createQuestionTools(options.questions === true && options.readOnly !== true),
    ...createReadOnlyTools(readers, options.approvalTool.name, reportToolEvent),
  ];
  const unknownTool = createUnknownToolMiddleware(() => tools.map((entry) => entry.name));
  const batchRejections = createBatchRejections();
  const agent = createDeepAgent({
    model,
    middleware: [
      // Same name as DeepAgents' summarization, so it replaces that default in place.
      createCompactionMiddleware(),
      ...(options.readOnly === true
        ? [createReadOnlyStartupMiddleware(readers), unknownTool]
        : [
            unknownTool,
            checks.middleware,
            batchRejections.middleware,
            ...(gate === null ? [] : [gate.middleware]),
          ]),
    ],
    tools,
    systemPrompt: options.systemPrompt,
    checkpointer,
    subagents: [],
    // Stryker disable next-line all: the unknown-tool middleware answers every built-in call first; this denial is defense in depth.
    permissions: [{ operations: ["read", "write"], paths: ["/**"], mode: "deny" }],
    interruptOn:
      options.readOnly === true
        ? {}
        : {
            ...questionInterrupts(options.questions === true, checks.noReview),
            ...controlled.interrupts,
          },
  });

  return Object.freeze({
    recoverMessage: async (turn: MessageIdentity): Promise<AgentRecovery | null> => {
      streamConfig(turn.sessionId, turn.messageId, new AbortController().signal);
      const recovered = await recoverGraphTurn(
        (config) => agent.graph.getState(config),
        checkpointer,
        turn,
      );
      await persistRecoveredApproval(checkpointer, turn, recovered);
      return recovered === null ? null : recoveryAfterPrefix(recovered, turn.assistantText);
    },
    streamMessage: (turn: MessageTurn, signal: AbortSignal) => {
      if (turn.kind === "startup" && options.readOnly !== true) {
        throw invalidDependency("Tutor startup requires a read-only runtime.");
      }
      const input = createTurnInput(turn);
      const config = streamConfig(turn.sessionId, turn.messageId, signal);
      return streamMessageWithRecovery(
        turn,
        config,
        (checkpointConfig) => agent.graph.getState(checkpointConfig),
        (runConfig, unanswered) =>
          agent.streamEvents(
            {
              messages: [...unanswered, input],
            },
            runConfig,
          ) as unknown as UpstreamRun,
        (runConfig) => agent.streamEvents(null as never, runConfig) as unknown as UpstreamRun,
        signal,
        checkpointer,
        drainToolEvents,
      );
    },
    resumeApproval: (turn: ApprovalTurn, signal: AbortSignal) => {
      const toolName = turn.toolName ?? options.approvalTool.name;
      if (
        toolName !== options.approvalTool.name &&
        !effectTools.some((effect) => effect.name === toolName) &&
        !(options.questions === true && toolName === QUESTION_TOOL_NAME)
      )
        throw invalidDependency("The requested interrupt tool is not available.");
      const config = streamConfig(turn.sessionId, turn.messageId, signal);
      const decisions = turn.decisions ?? [turn.decision];
      return resumeApprovalWithRecovery(
        turn,
        config,
        toolName,
        (checkpointConfig) => agent.graph.getState(checkpointConfig),
        (runConfig, state) => {
          const pending = pendingApproval(state);
          return agent.streamEvents(
            new Command({
              resume: { decisions: batchRejections.plan(state, pending.actions, decisions) },
            }),
            runConfig,
          ) as unknown as UpstreamRun;
        },
        (runConfig) => agent.streamEvents(null as never, runConfig) as unknown as UpstreamRun,
        signal,
        checkpointer,
        drainToolEvents,
      );
    },
  });
}

function streamConfig(sessionId: string, messageId: string, signal: AbortSignal) {
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new AgentAdapterError("invalid-session-id", "The session identifier is invalid.");
  }
  const parsedMessageId = messageIdSchema.safeParse(messageId);
  if (!parsedMessageId.success) {
    throw new AgentAdapterError("invalid-message-id", "The message identifier is invalid.");
  }
  return {
    version: "v3" as const,
    configurable: { thread_id: parsed.data },
    metadata: { messageId: parsedMessageId.data },
    signal,
  };
}

export async function* translateRun(
  start: () => UpstreamRun | PromiseLike<UpstreamRun>,
  signal: AbortSignal,
  submittedDecision?: ApprovalDecision["type"],
  recordTurn?: (
    state: "pending-approval" | "in-progress" | "completed",
    events: readonly AgentEvent[],
  ) => Promise<void>,
  cancelTurn?: (events: readonly AgentEvent[]) => Promise<void>,
  drainToolEvents?: () => readonly ToolLifecycleEvent[],
): AsyncGenerator<AgentEvent> {
  let output: unknown;
  const events: AgentEvent[] = [];
  const drainTools = function* (): Generator<AgentEvent> {
    if (drainToolEvents !== undefined) yield* drainToolEvents();
  };
  try {
    const run = await start();
    if (submittedDecision !== undefined) {
      const event = { type: "tool-approval-submitted" as const, decision: submittedDecision };
      events.push(event);
      yield event;
    }
    for await (const message of run.messages) {
      // Tools can run while awaiting the next model message/token. Publish them
      // before the following response rather than draining after its text.
      yield* drainTools();
      for await (const text of message.text) {
        yield* drainTools();
        if (text.length > 0) {
          const event = { type: "assistant-text-delta" as const, text };
          events.push(event);
          // The UI must never persist a prefix newer than the adapter's recovery journal.
          await safelyRecordTurn(recordTurn, "in-progress", events);
          yield event;
        }
      }
      yield* drainTools();
    }
    yield* drainTools();
    output = await run.output;
  } catch (error: unknown) {
    yield* drainTools();
    if (signal.aborted) {
      const cancelled = { type: "turn-cancelled" as const };
      events.push(cancelled);
      await cancelTurn?.(events);
      yield cancelled;
      return;
    }
    if (error instanceof AgentAdapterError) {
      throw error;
    }
    await safelyRecordTurn(recordTurn, "in-progress", events);
    throw upstreamFailure(error);
  }
  const approvalEvent = parseApprovalEvent(output);
  if (approvalEvent !== null) {
    await safelyRecordTurn(recordTurn, "pending-approval", [...events, approvalEvent]);
    yield approvalEvent;
    return;
  }
  const completed = { type: "turn-completed" as const };
  events.push(completed);
  await safelyRecordTurn(recordTurn, "completed", events);
  yield completed;
}

async function persistRecoveredApproval(
  checkpointer: NonNullable<ReturnType<typeof resolveCheckpoint>>,
  turn: MessageIdentity,
  recovered: Awaited<ReturnType<typeof recoverGraphTurn>>,
): Promise<void> {
  if (recovered?.type !== "pending-approval") return;
  await safelyRecordTurn(
    recordTurnWith(checkpointer, turn, "", recovered.superseded),
    "pending-approval",
    recovered.events,
  );
}

async function* streamMessageWithRecovery(
  turn: MessageTurn,
  config: RunnableConfig,
  getState: (config: RunnableConfig) => Promise<unknown>,
  start: (
    config: RunnableConfig,
    unanswered: readonly BaseMessage[],
  ) => UpstreamRun | PromiseLike<UpstreamRun>,
  continueRun: (config: RunnableConfig) => UpstreamRun | PromiseLike<UpstreamRun>,
  signal: AbortSignal,
  checkpointer: ReturnType<typeof resolveCheckpoint> & {},
  drainToolEvents?: () => readonly ToolLifecycleEvent[],
): AsyncGenerator<AgentEvent> {
  const recovered = await recoverGraphTurn(getState, checkpointer, turn);
  if (recovered === null && (turn.assistantText?.length ?? 0) > 0) throw invalidReplayPrefix();
  if (recovered !== null && recovered.type !== "in-progress") {
    await persistRecoveredApproval(checkpointer, turn, recovered);
    yield* recoveryAfterPrefix(recovered, turn.assistantText).events;
    return;
  }
  let run: () => UpstreamRun | PromiseLike<UpstreamRun>;
  let base = "";
  let superseded: SupersededText | null = null;
  if (recovered === null) {
    const sessionHead = await checkpointer.findSessionHead(turn.sessionId, async (candidate) =>
      isCompletedGraphState(await getState(candidate)),
    );
    const runConfig =
      sessionHead === null
        ? emptyBranchConfig(config, turn.messageId)
        : continuationConfig(config, sessionHead);
    // A question whose turn failed stays in the conversation, without its partial answer.
    const unanswered = await withUnansweredInputs(checkpointer, getState, turn, sessionHead);
    run = () => start(runConfig, unanswered);
  } else {
    const continuation = beginContinuation(turn.assistantText, recovered);
    yield* continuation.events;
    base = continuation.assistantText;
    superseded = continuation.superseded;
    const runConfig = continuationConfig(config, recovered.checkpointConfig);
    run = () => continueRun(runConfig);
  }
  yield* translateRun(
    run,
    signal,
    undefined,
    recordTurnWith(checkpointer, turn, base, superseded),
    cancelTurnWith(checkpointer, turn, base),
    drainToolEvents,
  );
}

async function* resumeApprovalWithRecovery(
  turn: ApprovalTurn,
  config: RunnableConfig,
  toolName: string,
  getState: (config: RunnableConfig) => Promise<unknown>,
  resume: (config: RunnableConfig, state: unknown) => UpstreamRun | PromiseLike<UpstreamRun>,
  continueRun: (config: RunnableConfig) => UpstreamRun | PromiseLike<UpstreamRun>,
  signal: AbortSignal,
  checkpointer: ReturnType<typeof resolveCheckpoint> & {},
  drainToolEvents?: () => readonly ToolLifecycleEvent[],
): AsyncGenerator<AgentEvent> {
  const recovered = await recoverGraphTurn(getState, checkpointer, turn);
  if (recovered?.type === "completed" || recovered?.type === "cancelled") {
    yield* recoveryAfterPrefix(recovered, turn.assistantText).events;
    return;
  }
  if (recovered?.type === "in-progress") {
    assertRecoveredReview(recovered, turn.reviewId, toolName);
    const continuation = beginContinuation(turn.assistantText, recovered);
    yield* continuation.events;
    const runConfig = continuationConfig(config, recovered.checkpointConfig);
    yield* translateRun(
      () => continueRun(runConfig),
      signal,
      undefined,
      recordTurnWith(checkpointer, turn, continuation.assistantText, continuation.superseded),
      cancelTurnWith(checkpointer, turn, continuation.assistantText),
      drainToolEvents,
    );
    return;
  }
  const runConfig = continuationConfig(config, recovered?.checkpointConfig ?? config);
  const replay = recovered === null ? null : recoveryAfterPrefix(recovered, turn.assistantText);
  let pendingState: unknown;
  if (recovered !== null) {
    pendingState = await getState(runConfig);
    assertPendingReview(pendingState, turn.reviewId, toolName, turn.messageId, decisionCount(turn));
    await persistRecoveredApproval(checkpointer, turn, recovered);
  }
  if (replay !== null) {
    yield* replay.events.filter(
      (event) => event.type === "assistant-text-delta" || event.type === "assistant-text-restarted",
    );
  }
  yield* translateRun(
    async () => {
      if (recovered === null) {
        pendingState = await getState(runConfig);
        assertPendingReview(
          pendingState,
          turn.reviewId,
          toolName,
          turn.messageId,
          decisionCount(turn),
        );
      }
      return resume(runConfig, pendingState);
    },
    signal,
    (turn.decisions?.[0] ?? turn.decision).type,
    recordTurnWith(
      checkpointer,
      turn,
      recovered?.assistantText ?? "",
      recovered?.superseded ?? null,
    ),
    cancelTurnWith(checkpointer, turn, recovered?.assistantText ?? ""),
    drainToolEvents,
  );
}

function decisionCount(turn: ApprovalTurn): number {
  return turn.decisions?.length ?? 1;
}

function invalidDependency(message: string): AgentAdapterError {
  return new AgentAdapterError("invalid-runtime-dependency", message);
}
