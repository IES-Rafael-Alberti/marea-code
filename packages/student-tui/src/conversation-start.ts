import type {
  ConversationAction,
  ConversationLanguageChange,
  ConversationCopy,
  ConversationTuiOptions,
  ConversationTuiSession,
  ConversationView,
} from "./conversation-contracts.js";
import { startConversationTuiWithPorts } from "./conversation-runtime.js";
import { createNodeEnvironment } from "./platform/node-environment.boundary.js";

async function createLazyConversationView(
  copy: ConversationCopy,
  onAction: (action: ConversationAction) => void,
  onLanguageCommand?: (
    copy: ConversationCopy,
  ) => ConversationLanguageChange | Promise<ConversationLanguageChange | null> | null,
): Promise<ConversationView> {
  const { createConversationView } = await import("./platform/conversation-view.js");
  return createConversationView(copy, onAction, undefined, onLanguageCommand);
}

export function startConversationTui(
  options: ConversationTuiOptions,
): Promise<ConversationTuiSession> {
  return startConversationTuiWithPorts(
    options,
    createNodeEnvironment(),
    createLazyConversationView,
  );
}
