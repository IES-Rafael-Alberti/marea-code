import type { QuestionRequest } from "@marea/deepagents-adapter";

import type { AgentEvent, QuestionReply } from "./contracts.js";
import type {
  ActiveRun,
  SessionTurnExecutorOptions,
  StableTurnIdentity,
} from "./session-turn-executor.js";
import { TeacherActivity } from "./teacher-activity.js";
import { interactionAfterAbort } from "./turn-interaction.js";

/** Shows a tool row of the turn to the student. */
export function presentTool(
  options: SessionTurnExecutorOptions,
  identity: StableTurnIdentity,
  event: Extract<AgentEvent, { readonly type: "tool-started" | "tool-finished" }>,
): void {
  if (event.type === "tool-started")
    options.studentInterface.present({
      ...identity,
      arguments: event.arguments,
      callId: event.callId,
      name: event.name,
      type: "tool-started",
    });
  else
    options.studentInterface.present({
      ...identity,
      callId: event.callId,
      failed: event.failed,
      result: event.result,
      type: "tool-finished",
    });
}

export async function questionEvents(
  options: SessionTurnExecutorOptions,
  event: Extract<AgentEvent, { readonly type: "questions-required" }>,
  active: ActiveRun,
  identity: StableTurnIdentity,
  signal: AbortSignal,
  assistantText: string,
  allowWrites: boolean,
): Promise<AsyncIterable<AgentEvent> | null> {
  const continueQuestions = options.agent.resumeQuestions?.bind(options.agent);
  if (!allowWrites || continueQuestions === undefined) throw questionsUnsupported();
  const reply = await askStudent(options, event.request, identity, signal);
  if (reply.type === "cancel") return null;
  return continueQuestions(
    {
      ...active,
      messageId: identity.messageId,
      assistantText,
      request: event.request,
      values: reply.values,
    },
    signal,
  );
}

function questionsUnsupported(): Error {
  return new Error("Structured questions are not supported in this turn.");
}

/** Asks the student the questions of one interrupt and records the reply for the teacher. */
export async function askStudent(
  options: SessionTurnExecutorOptions,
  request: QuestionRequest,
  identity: StableTurnIdentity,
  signal: AbortSignal,
): Promise<QuestionReply> {
  const ask = options.studentInterface.askQuestions?.bind(options.studentInterface);
  if (ask === undefined) throw questionsUnsupported();
  const reply = await interactionAfterAbort<QuestionReply | undefined>(
    () => ask({ ...request, ...identity }),
    signal,
    undefined,
    "Structured question failed.",
  );
  signal.throwIfAborted();
  if (reply === undefined) throw new Error("The question interface returned no reply.");
  await new TeacherActivity(options).questions(identity, request, reply);
  signal.throwIfAborted();
  return reply;
}
