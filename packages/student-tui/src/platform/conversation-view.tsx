/** @jsxImportSource @opentui/react */
import { createRenderSchedule } from "./render-schedule.js";
import type {
  ConversationAction,
  ConversationLanguageChange,
  ConversationCopy,
  ConversationSnapshot,
  ConversationView,
} from "../conversation-contracts.js";
import { createPresentation } from "../parity/presentation.js";
import { LiveParityScreen } from "./parity/live-screen.js";
import { createNativeOpenTuiHost } from "./native-host.boundary.js";

export async function createConversationView(
  copy: ConversationCopy,
  onAction: (action: ConversationAction) => void,
  createHost: typeof createNativeOpenTuiHost = createNativeOpenTuiHost,
  onLanguageCommand?: (
    copy: ConversationCopy,
  ) => ConversationLanguageChange | Promise<ConversationLanguageChange | null> | null,
): Promise<ConversationView> {
  const host = await createHost({ mouse: copy.mouse ?? true });
  let currentCopy = copy;
  const parity = copy.parity;
  function requestRender(): void {
    schedule.request(false);
  }
  const languageCommand =
    onLanguageCommand === undefined
      ? undefined
      : async (): Promise<ConversationLanguageChange | null> => {
          const change = await onLanguageCommand(currentCopy);
          if (change !== null) {
            currentCopy = change.copy;
            requestRender();
          }
          return change;
        };
  const presentation = createPresentation(
    parity.context,
    parity.copy,
    onAction,
    parity.history,
    languageCommand,
  );
  const schedule = createRenderSchedule(() => {
    host.render(
      <LiveParityScreen
        copy={currentCopy.parity.copy}
        presentation={presentation}
        onAction={onAction}
      />,
    );
  });
  return Object.freeze({
    dispose(): void {
      schedule.dispose();
      host.dispose();
    },
    render(snapshot: ConversationSnapshot): void {
      presentation.sync(snapshot);
      schedule.request(snapshot.status === "streaming");
    },
    setCopy(next: ConversationCopy): void {
      currentCopy = next;
      presentation.setCopy(next.parity.copy);
      schedule.request(false);
    },
  });
}
