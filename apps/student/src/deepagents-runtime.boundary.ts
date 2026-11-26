import { RequiredSkillContext } from "./required-skill-context.js";
import { deniesWrite, socraticOptions } from "./operation-mediator.js";
import { OperationMediator } from "./operation-mediator.js";
import { rejectionReason } from "./rejection-reason.js";
import { writeRequestProblem, type WriteRequest } from "./write-request.js";
import { parseApprovalId, parseWriteRequest, StudentAgentBridgeError } from "./bridge-parsing.js";
export { StudentAgentBridgeError } from "./bridge-parsing.js";
import type { OperationTurn } from "./operation-contracts.js";
import {
  createAgentRuntime,
  QUESTION_TOOL_NAME,
  parseQuestions,
  questionAnswers,
  questionsProblem,
  type AgentEvent as DeepAgentEvent,
  type AgentRuntime as DeepAgentRuntime,
  type AgentRuntimeOptions as DeepAgentRuntimeOptions,
  type ApprovalTool,
  type ReadOnlyTool,
} from "@marea/deepagents-adapter";
import {
  STARTUP_MESSAGE_ID,
  type ApprovalId,
  type RunId,
  type StudentRunSnapshot,
} from "@marea/protocol";

import { batchDecisions, batchEventFor } from "./deepagents-batch.js";
import {
  approvalStateFor,
  assertDurableApprovalContext,
  type DurableAgentApprovalTurn,
} from "./durable-approval.js";
import type {
  AgentBatchTurn,
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
  readonly loadSkills?: (
    runId: RunId,
    snapshot: StudentRunSnapshot,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly checkpoint: DeepAgentRuntimeOptions["checkpoint"];
  readonly operations?: boolean;
  readonly projectContext?: (snapshot: StudentRunSnapshot) => string;
  readonly createRuntime?: DeepAgentRuntimeFactory;
  readonly model: DeepAgentRuntimeOptions["model"];
  readonly readOnlyTools?: (runId: RunId, snapshot: StudentRunSnapshot) => readonly ReadOnlyTool[];
}

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

class ApprovalToolMediator implements ApprovalTool {
  readonly name = INTERNAL_WRITE_TOOL_NAME;
  readonly description =
    "Write approved text content to a file in the student workspace. Arguments: file_path, content. Use a project-relative path such as main.py or src/main.py; /main.py also refers to the project root. Parent traversal is not allowed.";
  /** Every approved write of one turn; a batch may approve several. */
  // Stryker disable next-line ArrayDeclaration: an entry that is not a write never matches one.
  private authorized: AuthorizedWrite[] = [];

  authorize(request: WriteRequest, result: WorkspaceWrite): void {
    this.authorized.push({ content: request.content, path: request.path, result });
  }

  clearAuthorization(): void {
    // Stryker disable next-line ArrayDeclaration: see the field.
    this.authorized = [];
  }

  validate(arguments_: Readonly<Record<string, string>>): string | null {
    return writeRequestProblem(arguments_);
  }

  // The upstream tool contract is asynchronous even though this mediator performs no I/O.
  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(arguments_: Readonly<Record<string, string>>): Promise<string> {
    const request = parseWriteRequest(arguments_);
    const index = this.authorized.findIndex(
      (write) => write.path === request.path && write.content === request.content,
    );
    const authorized = this.authorized[index];
    if (authorized === undefined) {
      // Stryker disable next-line ArrayDeclaration: see the field.
      this.authorized = [];
      throw new StudentAgentBridgeError(
        "DeepAgents attempted a workspace write that was not approved.",
      );
    }
    this.authorized.splice(index, 1);
    return JSON.stringify(authorized.result);
  }
}

class DeepAgentsStudentRuntime implements AgentRuntime {
  private readonly skills = new RequiredSkillContext();
  private readonly contexts = new Map<RunId, RunContexts>();
  private readonly createRuntime: DeepAgentRuntimeFactory;

  constructor(private readonly options: DeepAgentsStudentRuntimeOptions) {
    this.createRuntime = options.createRuntime ?? createAgentRuntime;
  }

  prepare(turn: Pick<AgentMessageTurn, "runId" | "snapshot">, signal: AbortSignal): Promise<void> {
    return this.skills.prepare(turn.runId, turn.snapshot, signal, this.options.loadSkills);
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
      // A pending call saved before arguments were checked is answered, not replayed forever.
      (event, textSoFar) => {
        const reason = unreviewable(event, context);
        if (reason === null) return null;
        return context.runtime.resumeApproval(
          {
            assistantText: textSoFar,
            messageId: turn.messageId,
            sessionId: turn.runId,
            reviewId: event.reviewId,
            toolName: event.toolName,
            decision: { type: "reject", reason },
          },
          signal,
        );
      },
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

  async *resumeBatch(turn: AgentBatchTurn, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const context = this.contextForRun(turn.runId, turn.snapshot);
    const mediators = { operations: context.operations, writes: context.mediator };
    try {
      const { toolName, decision, decisions } = batchDecisions(turn, mediators);
      const assistantText = turn.assistantText ?? "";
      yield* this.translate(
        context.runtime.resumeApproval(
          {
            sessionId: turn.runId,
            messageId: turn.messageId,
            assistantText,
            reviewId: turn.reviewId,
            toolName,
            decision,
            decisions,
          },
          signal,
        ),
        context,
        turn.messageId,
        assistantText,
      );
    } finally {
      context.mediator.clearAuthorization();
      for (const operation of context.operations) operation.clear();
    }
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
                : {
                    type: "reject",
                    reason: rejectionReason(turn.reason, "The student rejected this operation."),
                  },
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
        systemPrompt: this.skills.prompt(runId, snapshot, this.options.projectContext?.(snapshot)),
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
                    reason: rejectionReason(
                      turn.reason,
                      "The student rejected the workspace edit.",
                    ),
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
    answerUnreviewable?: (
      event: Extract<DeepAgentEvent, { readonly type: "tool-approval-required" }>,
      assistantText: string,
    ) => AsyncIterable<DeepAgentEvent> | null,
  ): AsyncGenerator<AgentEvent> {
    let pendingApprovalId: ApprovalId | null = null;
    let assistantText = initialAssistantText;
    for await (const event of events) {
      if (event.type === "tool-approval-submitted") continue;
      if (event.type === "tool-approval-required") {
        const answered = answerUnreviewable?.(event, assistantText) ?? null;
        if (answered !== null) {
          yield* this.translate(answered, context, messageId, assistantText, answerUnreviewable);
          return;
        }
        const approval = approvalEventFor(event, context);
        if (approval.type === "write-approval-required") {
          if (pendingApprovalId === approval.approvalId) {
            throw new StudentAgentBridgeError("DeepAgents repeated a pending approval.");
          }
          pendingApprovalId = approval.approvalId;
        }
        yield approval;
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

/** Why a single call cannot be shown to the student, or null; a batch is never answered here. */
function unreviewable(
  event: Extract<DeepAgentEvent, { readonly type: "tool-approval-required" }>,
  context: RunContext,
): string | null {
  if (event.actions.length > 1) return null;
  if (event.toolName === QUESTION_TOOL_NAME) return questionsProblem(event.arguments);
  const operation = context.operations.find((candidate) => candidate.name === event.toolName);
  if (operation !== undefined) return operation.validate(event.arguments);
  return event.toolName === INTERNAL_WRITE_TOOL_NAME
    ? context.mediator.validate(event.arguments)
    : null;
}

/** The student-side request for one interrupt: a batch, questions, an operation or a write. */
function approvalEventFor(
  event: Extract<
    import("@marea/deepagents-adapter").AgentEvent,
    { type: "tool-approval-required" }
  >,
  context: RunContext,
): AgentEvent {
  if (event.actions.length > 1)
    return batchEventFor(event, { operations: context.operations, writes: context.mediator });
  if (event.toolName === QUESTION_TOOL_NAME)
    return {
      type: "questions-required",
      request: { interruptId: event.reviewId, questions: parseQuestions(event.arguments) },
    };
  const operation = context.operations.find((candidate) => candidate.name === event.toolName);
  if (operation !== undefined)
    return {
      type: "operation-approval-required",
      approvalId: parseApprovalId(event.reviewId),
      tool: operation.operation,
      arguments: event.arguments,
      summary: event.description,
    };
  if (event.toolName !== INTERNAL_WRITE_TOOL_NAME) {
    throw new StudentAgentBridgeError("DeepAgents requested an unsupported tool.");
  }
  const request = parseWriteRequest(event.arguments);
  return {
    type: "write-approval-required",
    approvalId: parseApprovalId(event.reviewId),
    content: request.content,
    path: request.path,
    summary: event.description,
  };
}

export function createDeepAgentsStudentRuntime(
  options: DeepAgentsStudentRuntimeOptions,
): AgentRuntime & Required<Pick<AgentRuntime, "streamStartup" | "resumeQuestions">> {
  return new DeepAgentsStudentRuntime(options);
}
