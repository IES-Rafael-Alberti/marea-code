import { createSocraticGate } from "./socratic-gate.boundary.js";
import { createControlledTools } from "./controlled-tools.boundary.js";
import { toUpstreamDecision } from "./approval-decision.js";
import {
  createQuestionTools,
  questionInterrupts,
  QUESTION_TOOL_NAME,
} from "./questions.boundary.js";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { type BaseMessageChunk } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";
import { createDeepAgent, registerHarnessProfile } from "deepagents";
import { createMiddleware } from "langchain";
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
} from "./approval-state.boundary.js";
import { resolveCheckpoint } from "./checkpoint.boundary.js";
import { MareaGatewayChatModel } from "./gateway-model.boundary.js";
import { createReadOnlyTools } from "./read-tools.boundary.js";
import { createTurnInput } from "./turn-input.boundary.js";
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

export { assertPendingReview, parseApprovalEvent };

export interface DiagnosticCause {
  readonly name: string;
  readonly message: string;
}

interface UpstreamRun {
  readonly messages: AsyncIterable<{ readonly text: AsyncIterable<string> }>;
  readonly output: PromiseLike<unknown>;
}

const PROFILE_KEY = "openai:marea";
const modelRegistry = new WeakMap<AgentModel, BaseLanguageModel<BaseMessageChunk>>();
const diagnosticCauseRegistry = new WeakMap<AgentAdapterError, DiagnosticCause>();
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
  const controlled = createControlledTools(
    [options.approvalTool, ...effectTools],
    reportToolEvent,
    gate?.shouldBlock,
  );
  const agent = createDeepAgent({
    model,
    middleware:
      options.readOnly === true
        ? [
            createMiddleware({
              name: "MareaReadOnlyStartup",
              wrapModelCall: (request, handler) =>
                handler({
                  ...request,
                  tools: request.tools.filter(
                    (candidate) =>
                      options.readOnlyTools?.some((reader) => reader.name === candidate.name) ===
                      true,
                  ),
                }),
            }),
          ]
        : gate === null
          ? []
          : [gate.middleware],
    tools: [
      ...(options.readOnly === true ? [] : controlled.tools),
      ...createQuestionTools(options.questions === true && options.readOnly !== true),
      ...createReadOnlyTools(
        options.readOnlyTools ?? [],
        options.approvalTool.name,
        reportToolEvent,
      ),
    ],
    systemPrompt: options.systemPrompt,
    checkpointer,
    subagents: [],
    permissions: [{ operations: ["read", "write"], paths: ["/**"], mode: "deny" }],
    interruptOn:
      options.readOnly === true
        ? {}
        : {
            ...questionInterrupts(options.questions === true),
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
        (runConfig) =>
          agent.streamEvents(
            {
              messages: [input],
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
      return resumeApprovalWithRecovery(
        turn,
        config,
        toolName,
        (checkpointConfig) => agent.graph.getState(checkpointConfig),
        (runConfig) =>
          agent.streamEvents(
            new Command({
              resume: {
                decisions: [toUpstreamDecision(turn.decision, toolName)],
              },
            }),
            runConfig,
          ) as unknown as UpstreamRun,
        (runConfig) => agent.streamEvents(null as never, runConfig) as unknown as UpstreamRun,
        signal,
        checkpointer,
        drainToolEvents,
      );
    },
  });
}

export function diagnosticCauseFor(error: AgentAdapterError): DiagnosticCause | null {
  return diagnosticCauseRegistry.get(error) ?? null;
}

export function normalizeDiagnosticCause(input: unknown): DiagnosticCause {
  return input instanceof Error
    ? Object.freeze({ name: input.name, message: input.message })
    : Object.freeze({
        name: "NonErrorThrownValue",
        message: "The upstream runtime threw a non-Error value.",
      });
}

function registerMareaProfile(): void {
  registerHarnessProfile(PROFILE_KEY, {
    excludedTools: ["task"],
    generalPurposeSubagent: { enabled: false },
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
  replayText = "",
  drainToolEvents?: () => readonly ToolLifecycleEvent[],
): AsyncGenerator<AgentEvent> {
  let output: unknown;
  const events: AgentEvent[] = [];
  let remainingReplayText = replayText;
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
        let delta = text;
        if (remainingReplayText.startsWith(delta)) {
          remainingReplayText = remainingReplayText.slice(delta.length);
          delta = "";
        } else if (delta.startsWith(remainingReplayText)) {
          delta = delta.slice(remainingReplayText.length);
          remainingReplayText = "";
        } else {
          throw invalidReplayPrefix();
        }
        if (delta.length > 0) {
          const event = { type: "assistant-text-delta" as const, text: delta };
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
    if (remainingReplayText.length > 0) throw invalidReplayPrefix();
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

async function safelyRecordTurn(
  recordTurn:
    | ((
        state: "pending-approval" | "in-progress" | "completed",
        events: readonly AgentEvent[],
      ) => Promise<void>)
    | undefined,
  state: "pending-approval" | "in-progress" | "completed",
  events: readonly AgentEvent[],
): Promise<void> {
  try {
    await recordTurn?.(state, events);
  } catch (error: unknown) {
    if (error instanceof AgentAdapterError) throw error;
    throw upstreamFailure(error);
  }
}

async function persistRecoveredApproval(
  checkpointer: NonNullable<ReturnType<typeof resolveCheckpoint>>,
  turn: MessageIdentity,
  recovered: Awaited<ReturnType<typeof recoverGraphTurn>>,
): Promise<void> {
  if (recovered?.type !== "pending-approval") return;
  await safelyRecordTurn(
    recordTurnWith(checkpointer, turn, ""),
    "pending-approval",
    recovered.events,
  );
}

function upstreamFailure(error: unknown): AgentAdapterError {
  const adapterError = new AgentAdapterError(
    "upstream-execution-failed",
    "The agent runtime failed without exposing provider diagnostics.",
  );
  // The classifier downstream reads the typed cause; prose is never parsed.
  // Non-enumerable, so the cause never leaks into serialized errors.
  Object.defineProperty(adapterError, "cause", { value: error });
  diagnosticCauseRegistry.set(adapterError, normalizeDiagnosticCause(error));
  return adapterError;
}

async function* streamMessageWithRecovery(
  turn: MessageTurn,
  config: RunnableConfig,
  getState: (config: RunnableConfig) => Promise<unknown>,
  start: (config: RunnableConfig) => UpstreamRun | PromiseLike<UpstreamRun>,
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
  if (recovered !== null) {
    yield* recoveryAfterPrefix(recovered, turn.assistantText).events;
  }
  let runConfig: RunnableConfig;
  let run: () => UpstreamRun | PromiseLike<UpstreamRun>;
  if (recovered === null) {
    const sessionHead = await checkpointer.findSessionHead(turn.sessionId, async (candidate) =>
      isCompletedGraphState(await getState(candidate)),
    );
    runConfig =
      sessionHead === null
        ? emptyBranchConfig(config, turn.messageId)
        : continuationConfig(config, sessionHead);
    run = () => start(runConfig);
  } else {
    runConfig = continuationConfig(config, recovered.checkpointConfig);
    run = () => continueRun(runConfig);
  }
  yield* translateRun(
    run,
    signal,
    undefined,
    recordTurnWith(checkpointer, turn, recoveredAssistantText(recovered)),
    cancelTurnWith(checkpointer, turn, recoveredAssistantText(recovered)),
    recovered?.replayText ?? "",
    drainToolEvents,
  );
}

async function* resumeApprovalWithRecovery(
  turn: ApprovalTurn,
  config: RunnableConfig,
  toolName: string,
  getState: (config: RunnableConfig) => Promise<unknown>,
  resume: (config: RunnableConfig) => UpstreamRun | PromiseLike<UpstreamRun>,
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
    yield* recoveryAfterPrefix(recovered, turn.assistantText).events;
    const runConfig = continuationConfig(config, recovered.checkpointConfig);
    yield* translateRun(
      () => continueRun(runConfig),
      signal,
      undefined,
      recordTurnWith(checkpointer, turn, recovered.assistantText),
      cancelTurnWith(checkpointer, turn, recovered.assistantText),
      recovered.replayText,
      drainToolEvents,
    );
    return;
  }
  const runConfig = continuationConfig(config, recovered?.checkpointConfig ?? config);
  const replay = recovered === null ? null : recoveryAfterPrefix(recovered, turn.assistantText);
  if (recovered !== null) {
    const state = await getState(runConfig);
    assertPendingReview(state, turn.reviewId, toolName, turn.messageId);
    await persistRecoveredApproval(checkpointer, turn, recovered);
  }
  if (replay !== null) {
    yield* replay.events.filter((event) => event.type === "assistant-text-delta");
  }
  yield* translateRun(
    async () => {
      if (recovered === null) {
        const state = await getState(runConfig);
        assertPendingReview(state, turn.reviewId, toolName, turn.messageId);
      }
      return resume(runConfig);
    },
    signal,
    turn.decision.type,
    recordTurnWith(checkpointer, turn, recoveredAssistantText(recovered)),
    cancelTurnWith(checkpointer, turn, recoveredAssistantText(recovered)),
    undefined,
    drainToolEvents,
  );
}

function recoveredAssistantText(
  recovered: Awaited<ReturnType<typeof recoverGraphTurn>> | null,
): string {
  return recovered?.assistantText ?? "";
}

function invalidDependency(message: string): AgentAdapterError {
  return new AgentAdapterError("invalid-runtime-dependency", message);
}
