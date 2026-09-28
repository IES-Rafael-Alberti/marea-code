import type { StudentTuiEnvironment } from "./contracts.js";
import type {
  ConversationTuiOptions,
  ConversationTuiSession,
  ConversationViewFactory,
} from "./conversation-contracts.js";
import {
  createConversationTuiSession,
  type ConversationSessionBinding,
} from "./conversation-session.js";
import { StudentTuiStartupError } from "./startup-error.js";

export async function startConversationTuiWithPorts(
  options: ConversationTuiOptions,
  environment: StudentTuiEnvironment,
  createView: ConversationViewFactory,
): Promise<ConversationTuiSession> {
  if (!environment.interactive) throw new StudentTuiStartupError("NON_INTERACTIVE");

  let binding: ConversationSessionBinding | null = null;
  try {
    const view = await createView(
      options.copy,
      (action) => {
        if (binding !== null) binding.handleAction(action);
      },
      options.onLanguageCommand,
    );
    binding = createConversationTuiSession({
      initialTurn: options.initialTurn,
      onMessage: options.onMessage,
      nextAttemptId: options.nextAttemptId,
      nextMessageId: options.nextMessageId,
      setExitCode: environment.setExitCode,
      signals: environment.signals,
      view,
    });
    return binding.session;
  } catch {
    throw new StudentTuiStartupError("RENDERER_FAILED");
  }
}
