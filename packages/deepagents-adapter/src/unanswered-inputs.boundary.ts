import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import * as z from "zod";

import type { RuntimeCheckpointSaver } from "./durable-checkpoint.boundary.js";

const stateMessagesSchema = z
  .object({ values: z.object({ messages: z.array(z.unknown()) }).loose() })
  .loose();
const turnMetadataSchema = z.object({ messageId: z.string() }).loose();

/**
 * The student questions of turns that never completed after the session head. A new message
 * starts from the last completed turn, so without them a question whose answer failed would
 * vanish from the conversation. Only the questions are kept: the partial answer, tool calls
 * and results of a failed turn stay out of the context.
 */
export async function withUnansweredInputs(
  checkpointer: RuntimeCheckpointSaver,
  getState: (config: RunnableConfig) => Promise<unknown>,
  turn: { readonly sessionId: string; readonly messageId: string },
  head: RunnableConfig | null,
): Promise<readonly BaseMessage[]> {
  const latest = await latestTurnCheckpoint(checkpointer, turn.sessionId);
  // When the latest turn is the head itself, every question in it is answered.
  if (latest === null) return [];
  const answered = new Set<string>();
  if (head !== null)
    for (const message of questionsIn(await getState(head))) answered.add(message.id);
  return questionsIn(await getState(latest))
    .filter((message) => !answered.has(message.id) && message.id !== turn.messageId)
    .map((message) => new HumanMessage({ content: message.content, id: message.id }));
}

async function latestTurnCheckpoint(
  checkpointer: RuntimeCheckpointSaver,
  sessionId: string,
): Promise<RunnableConfig | null> {
  for await (const tuple of checkpointer.list({ configurable: { thread_id: sessionId } })) {
    if (turnMetadataSchema.safeParse(tuple.metadata).success) return tuple.config;
  }
  return null;
}

interface Question {
  readonly content: HumanMessage["content"];
  readonly id: string;
}

function questionsIn(state: unknown): readonly Question[] {
  const parsed = stateMessagesSchema.safeParse(state);
  if (!parsed.success) return [];
  return parsed.data.values.messages.flatMap((message) =>
    HumanMessage.isInstance(message) && typeof message.id === "string"
      ? [{ content: message.content, id: message.id }]
      : [],
  );
}
