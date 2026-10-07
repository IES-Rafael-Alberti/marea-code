import { deniesWrite, socraticOptions } from "./operation-mediator.js";
import { OperationMediator } from "./operation-mediator.js";
import { WriteRequestSchema, type WriteRequest } from "./write-request.js";
import type { OperationTurn } from "./operation-contracts.js";
import {
  createAgentRuntime,
  QUESTION_TOOL_NAME,
  parseQuestions,
  questionAnswers,
  type AgentRuntime as DeepAgentRuntime,
  type AgentRuntimeOptions as DeepAgentRuntimeOptions,
  type ApprovalTool,
  type ReadOnlyTool,
} from "@marea/deepagents-adapter";
import {
  ApprovalIdSchema,
  STARTUP_MESSAGE_ID,
  type ApprovalId,
  type RunId,
  type StudentRunSnapshot,
} from "@marea/protocol";

import type {
  AgentApprovalTurn,
  AgentQuestionTurn,
  AgentEvent,
  AgentMessageTurn,
  AgentRuntime,
  WorkspaceWrite,
} from "./contracts.js";

const INTERNAL_WRITE_TOOL_NAME = "marea_write_file";

export type DeepAgentRuntimeFactory = (options: DeepAgentRuntimeOptions) => DeepAgentRuntime;

export interface DeepAgentsStudentRuntimeOptions {
  readonly checkpoint: DeepAgentRuntimeOptions["checkpoint"];
  readonly operations?: boolean;
  readonly projectContext?: (snapshot: StudentRunSnapshot) => string;
  readonly createRuntime?: DeepAgentRuntimeFactory;
  readonly model: DeepAgentRuntimeOptions["model"];
  readonly readOnlyTools?: (runId: RunId, snapshot: StudentRunSnapshot) => readonly ReadOnlyTool[];
}

function parseApprovalId(reviewId: string): ApprovalId {
  const parsed = ApprovalIdSchema.safeParse(reviewId);
  if (!parsed.success) {
    throw new StudentAgentBridgeError("DeepAgents returned an invalid approval identity.");
  }
  return parsed.data;
}
export class StudentAgentBridgeError extends Error {}

interface PendingApproval extends WriteRequest {
  readonly approvalId: ApprovalId;
  readonly messageId: string;
  readonly reviewId: string;
  readonly summary: string;
}

interface DurableApprovalContext extends WriteRequest {
  readonly snapshot: StudentRunSnapshot;
  readonly summary: string;
}

type DurableAgentApprovalTurn = AgentApprovalTurn & DurableApprovalContext;

interface AuthorizedWrite extends WriteRequest {
  readonly result: WorkspaceWrite;
}
interface RunContext {
  readonly assistantText: Map<string, string>;
  readonly mediator: ApprovalToolMediator;
  readonly operations: readonly OperationMediator[];
  readonly runtime: DeepAgentRuntime;
  readonly snapshotId: string;
}
interface RunContexts {
  readonly snapshotId: string;
  readonly startup: RunContext | undefined;
  readonly conversation: RunContext | undefined;
}

async function approvalStateFor(
  runtime: DeepAgentRuntime,
  turn: DurableAgentApprovalTurn,
  assistantText: string,
): Promise<PendingApproval | null> {
  const recovery = await runtime.recoverMessage({
    assistantText,
    messageId: turn.messageId,
    sessionId: turn.runId,
  });
  if (recovery?.type === "in-progress") {
    return {
      approvalId: turn.approvalId,
      content: turn.content,
      messageId: turn.messageId,
      path: turn.path,
      reviewId: turn.approvalId,
      summary: turn.summary,
    };
  }
  if (recovery?.type !== "pending-approval") return null;
  const event = recovery.events.find((candidate) => candidate.type === "tool-approval-required");
  if (event?.toolName !== INTERNAL_WRITE_TOOL_NAME) {
    throw new StudentAgentBridgeError("The DeepAgents approval is not pending for this message.");
  }
  const approvalId = parseApprovalId(event.reviewId);
  if (approvalId !== turn.approvalId) {
    throw new StudentAgentBridgeError("The DeepAgents approval is not pending for this message.");
  }
  const pending = {
    ...parseWriteRequest(event.arguments),
    approvalId,
    messageId: turn.messageId,
    reviewId: event.reviewId,
    summary: event.description,
  };
  assertPersistedApprovalContext(turn, pending);
  return pending;
}

function assertPersistedApprovalContext(
  turn: DurableAgentApprovalTurn,
  pending: PendingApproval,
): void {
  const persisted = durableApprovalContext(turn);
  if (
    persisted.content !== pending.content ||
    persisted.path !== pending.path ||
    persisted.summary !== pending.summary
  ) {
    throw new StudentAgentBridgeError("The persisted approval does not match DeepAgents state.");
  }
}

function assertDurableApprovalContext(
  turn: AgentApprovalTurn,
): asserts turn is DurableAgentApprovalTurn {
  const candidate: Partial<DurableApprovalContext> = turn;
  if (
    typeof candidate.content !== "string" ||
    typeof candidate.path !== "string" ||
    candidate.snapshot === undefined ||
    typeof candidate.summary !== "string"
  ) {
    throw new StudentAgentBridgeError("The persisted approval context is incomplete.");
  }
}

function durableApprovalContext(turn: DurableAgentApprovalTurn): DurableApprovalContext {
  return {
    content: turn.content,
    path: turn.path,
    snapshot: turn.snapshot,
    summary: turn.summary,
  };
}

class ApprovalToolMediator implements ApprovalTool {
  readonly name = INTERNAL_WRITE_TOOL_NAME;
  readonly description =
    "Write approved text content to a file in the student workspace. Arguments: path, content. Use a project-relative path such as main.py or src/main.py; /main.py also refers to the project root. Parent traversal is not allowed.";
  private authorized: AuthorizedWrite | null = null;

  authorize(request: WriteRequest, result: WorkspaceWrite): void {
    this.authorized = { content: request.content, path: request.path, result };
  }

  clearAuthorization(): void {
    this.authorized = null;
  }

  // The upstream tool contract is asynchronous even though this mediator performs no I/O.
  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(arguments_: Readonly<Record<string, string>>): Promise<string> {
    const request = parseWriteRequest(arguments_);
    const authorized = this.authorized;
    if (authorized?.path !== request.path || authorized.content !== request.content) {
      this.authorized = null;
      throw new StudentAgentBridgeError(
        "DeepAgents attempted a workspace write that was not approved.",
      );
    }
    this.authorized = null;
    return JSON.stringify(authorized.result);
  }
}

function parseWriteRequest(arguments_: Readonly<Record<string, string>>): WriteRequest {
  const parsed = WriteRequestSchema.safeParse(arguments_);
  if (!parsed.success) {
    throw new StudentAgentBridgeError("DeepAgents returned invalid write_file arguments.");
  }
  return parsed.data;
}

class DeepAgentsStudentRuntime implements AgentRuntime {
  private readonly contexts = new Map<RunId, RunContexts>();
  private readonly createRuntime: DeepAgentRuntimeFactory;

  constructor(private readonly options: DeepAgentsStudentRuntimeOptions) {
    this.createRuntime = options.createRuntime ?? createAgentRuntime;
  }

  streamMessage(turn: AgentMessageTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const context = this.contextForRun(turn.runId, turn.snapshot);
    const assistantText = turn.assistantText ?? context.assistantText.get(turn.messageId) ?? "";
    context.assistantText.set(turn.messageId, assistantText);
    return this.translate(
      context.runtime.streamMessage(
        { assistantText, messageId: turn.messageId, sessionId: turn.runId, text: turn.text },
        signal,
      ),
      context,
      turn.messageId,
      assistantText,
    );
  }

  streamStartup(
    turn: Omit<AgentMessageTurn, "text">,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (
      turn.messageId !== STARTUP_MESSAGE_ID ||
      turn.snapshot.agentMode !== "tutoring" ||
      turn.snapshot.startup === undefined
    ) {
      throw new StudentAgentBridgeError("No internal tutor startup is configured for this turn.");
    }
    const context = this.contextForRun(turn.runId, turn.snapshot, true);
    const assistantText = turn.assistantText ?? context.assistantText.get(turn.messageId) ?? "";
    return this.translate(
      context.runtime.streamMessage(
        {
          kind: "startup",
          assistantText,
          messageId: turn.messageId,
          sessionId: turn.runId,
          text: turn.snapshot.startup.content,
        },
        signal,
      ),
      context,
      turn.messageId,
      assistantText,
    );
  }

  async *resumeQuestions(turn: AgentQuestionTurn, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const context = this.contextForRun(turn.runId, turn.snapshot);
    const assistantText = turn.assistantText ?? "";
    const recovery = await context.runtime.recoverMessage({
      assistantText,
      messageId: turn.messageId,
      sessionId: turn.runId,
    });
    const pending = recovery?.events.find((event) => event.type === "tool-approval-required");
    if (
      pending?.type !== "tool-approval-required" ||
      pending.toolName !== QUESTION_TOOL_NAME ||
      pending.reviewId !== turn.request.interruptId
    )
      throw new StudentAgentBridgeError("The question interrupt is no longer pending.");
    const questions = parseQuestions(pending.arguments);
    const values = questionAnswers(questions, turn.values);
    yield* this.translate(
      context.runtime.resumeApproval(
        {
          assistantText,
          messageId: turn.messageId,
          sessionId: turn.runId,
          reviewId: pending.reviewId,
          toolName: QUESTION_TOOL_NAME,
          decision: {
            type: "amend",
            arguments: { questions: JSON.stringify(questions), answers: JSON.stringify(values) },
          },
        },
        signal,
      ),
      context,
      turn.messageId,
      assistantText,
    );
  }

  resumeApproval(turn: AgentApprovalTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    assertDurableApprovalContext(turn);
    const context = this.contextForRun(turn.runId, turn.snapshot);
    let approvedEffect: WorkspaceWrite | null = null;
    if (turn.decision === "approved") {
      if (turn.effect === null) {
        throw new StudentAgentBridgeError("An approved write requires its durable effect.");
      }
      approvedEffect = turn.effect;
    } else if (turn.effect !== null) {
      throw new StudentAgentBridgeError("A rejected write cannot include an effect.");
    }
    return this.resumeRecovered(context, turn, approvedEffect, signal);
  }

  async *resumeOperation(turn: OperationTurn, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const context = this.contextForRun(turn.runId, turn.snapshot);
    const mediator = context.operations.find((candidate) => candidate.operation === turn.tool);
    if (mediator === undefined) throw new StudentAgentBridgeError("This operation is unavailable.");
    if (turn.decision === "approved") {
      if (turn.result === null)
        throw new StudentAgentBridgeError("The operation has no recorded result.");
      mediator.authorize(turn.arguments, turn.result);
    }
    try {
      yield* this.translate(
        context.runtime.resumeApproval(
          {
            sessionId: turn.runId,
            messageId: turn.messageId,
            assistantText: turn.assistantText ?? "",
            reviewId: turn.approvalId,
            toolName: mediator.name,
            decision:
              turn.decision === "approved"
                ? { type: "approve" }
                : { type: "reject", reason: turn.reason ?? "The student rejected this operation." },
          },
          signal,
        ),
        context,
        turn.messageId,
        turn.assistantText ?? "",
      );
    } finally {
      mediator.clear();
    }
  }

  private contextForRun(runId: RunId, snapshot: StudentRunSnapshot, startup = false): RunContext {
    const existing = this.contexts.get(runId);
    if (existing !== undefined) {
      if (existing.snapshotId !== snapshot.id) {
        throw new StudentAgentBridgeError("An active run cannot change its immutable snapshot.");
      }
      const cached = startup ? existing.startup : existing.conversation;
      if (cached !== undefined) return cached;
    }
    if (!startup && deniesWrite(snapshot))
      throw new StudentAgentBridgeError("The run snapshot denies workspace writes.");
    const mediator = new ApprovalToolMediator();
    const operations =
      this.options.operations === true && !startup
        ? (["edit_file", "execute", "delete"] as const)
            .filter(
              (tool) =>
                !snapshot.teacherToolPolicy.restrictions.some(
                  (rule) => rule.tool === tool && rule.effect === "deny",
                ),
            )
            .map((tool) => new OperationMediator(tool))
        : [];
    const context: RunContext = {
      operations,
      assistantText: new Map(),
      mediator,
      runtime: this.createRuntime({
        approvalTool: mediator,
        effectTools: operations,
        checkpoint: this.options.checkpoint,
        model: this.options.model,
        systemPrompt: [snapshot.prompt.content, this.options.projectContext?.(snapshot)]
          .filter(Boolean)
          .join("\n\n"),
        readOnlyTools: this.options.readOnlyTools?.(runId, snapshot) ?? [],
        readOnly: startup,
        questions: !startup,
        ...socraticOptions(snapshot, startup, mediator, operations),
      }),
      snapshotId: snapshot.id,
    };
    this.contexts.set(runId, {
      snapshotId: snapshot.id,
      startup: startup ? context : existing?.startup,
      conversation: startup ? existing?.conversation : context,
    });
    return context;
  }

  private async *resumeRecovered(
    context: RunContext,
    turn: DurableAgentApprovalTurn,
    approvedEffect: WorkspaceWrite | null,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const assistantText = turn.assistantText ?? context.assistantText.get(turn.messageId) ?? "";
    context.assistantText.set(turn.messageId, assistantText);
    const pending = await approvalStateFor(context.runtime, turn, assistantText);
    if (pending !== null && approvedEffect !== null) {
      context.mediator.authorize(pending, approvedEffect);
    }
    try {
      yield* this.translate(
        context.runtime.resumeApproval(
          {
            assistantText,
            messageId: turn.messageId,
            sessionId: turn.runId,
            reviewId: pending?.reviewId ?? turn.approvalId,
            decision:
              turn.decision === "approved"
                ? { type: "approve" }
                : {
                    type: "reject",
                    reason: turn.reason ?? "The student rejected the workspace edit.",
                  },
          },
          signal,
        ),
        context,
        turn.messageId,
        assistantText,
      );
    } finally {
      context.mediator.clearAuthorization();
    }
  }

  private async *translate(
    events: AsyncIterable<import("@marea/deepagents-adapter").AgentEvent>,
    context: RunContext,
    messageId: string,
    initialAssistantText: string,
  ): AsyncGenerator<AgentEvent> {
    let pendingApprovalId: ApprovalId | null = null;
    let assistantText = initialAssistantText;
    for await (const event of events) {
      if (event.type === "tool-approval-submitted") continue;
      if (event.type === "tool-approval-required") {
        if (event.toolName === QUESTION_TOOL_NAME) {
          yield {
            type: "questions-required",
            request: { interruptId: event.reviewId, questions: parseQuestions(event.arguments) },
          };
          continue;
        }
        const operation = context.operations.find((candidate) => candidate.name === event.toolName);
        if (operation !== undefined) {
          yield {
            type: "operation-approval-required",
            approvalId: parseApprovalId(event.reviewId),
            tool: operation.operation,
            arguments: event.arguments,
            summary: event.description,
          };
          continue;
        }
        if (event.toolName !== INTERNAL_WRITE_TOOL_NAME) {
          throw new StudentAgentBridgeError("DeepAgents requested an unsupported tool.");
        }
        const request = parseWriteRequest(event.arguments);
        const approvalId = parseApprovalId(event.reviewId);
        if (pendingApprovalId === approvalId) {
          throw new StudentAgentBridgeError("DeepAgents repeated a pending approval.");
        }
        pendingApprovalId = approvalId;
        yield {
          type: "write-approval-required",
          approvalId,
          content: request.content,
          path: request.path,
          summary: event.description,
        };
      } else {
        if (event.type === "assistant-text-delta") {
          assistantText += event.text;
          context.assistantText.set(messageId, assistantText);
        }
        yield event;
      }
    }
  }
}

export function createDeepAgentsStudentRuntime(
  options: DeepAgentsStudentRuntimeOptions,
): AgentRuntime & Required<Pick<AgentRuntime, "streamStartup" | "resumeQuestions">> {
  return new DeepAgentsStudentRuntime(options);
}
