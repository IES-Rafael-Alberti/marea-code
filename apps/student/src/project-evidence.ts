import type { MessageId } from "@marea/protocol";

/** Captures student windows separately from approved agent effects. */
export interface ProjectEvidence {
  start(): Promise<void>;
  context?(messageId: MessageId): Promise<string>;
  capture(actor: "student" | "agent" | "unknown", messageId?: MessageId): Promise<void>;
  beginAgent(messageId: MessageId): Promise<void>;
}
