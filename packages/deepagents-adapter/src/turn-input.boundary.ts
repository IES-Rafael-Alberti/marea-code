import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { STARTUP_MESSAGE_ID } from "@marea/protocol";

import { AgentAdapterError, type MessageTurn } from "./contracts.js";

export function createTurnInput(turn: MessageTurn): HumanMessage | SystemMessage {
  if ((turn.kind === "startup") !== (turn.messageId === STARTUP_MESSAGE_ID)) {
    throw new AgentAdapterError(
      "invalid-message-id",
      "The internal startup identity cannot be used as a student message.",
    );
  }
  const fields = { content: turn.text, id: turn.messageId };
  return turn.kind === "startup" ? new SystemMessage(fields) : new HumanMessage(fields);
}

export function isTurnInput(input: unknown): input is HumanMessage | SystemMessage {
  return (
    HumanMessage.isInstance(input) ||
    (SystemMessage.isInstance(input) && input.id === STARTUP_MESSAGE_ID)
  );
}
