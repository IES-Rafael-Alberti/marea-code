import type { KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { ConversationAction } from "../../conversation-contracts.js";
import { completionFor } from "../../parity/commands.js";
import type { ParityCopy } from "../../parity/copy.js";
import { actionForKey } from "../../parity/keys.js";
import { editComposer } from "./composer-editing.js";
import { nextFocus } from "../../parity/navigation.js";
import type { Presentation } from "../../parity/presentation.js";

export interface KeyboardContext {
  readonly approvalKeys: boolean;
  readonly copy: ParityCopy;
  readonly draft: string;
  readonly editor: TextareaRenderable | null;
  readonly focus: string;
  readonly height: number;
  readonly presentation: Presentation;
  readonly scroll: ScrollBoxRenderable | null;
  readonly targets: readonly string[];
  activate(id: string): void;
  dispatch(action: ConversationAction): void;
  focusOn(id: string): void;
  replaceDraft(text: string): void;
}

function recall(context: KeyboardContext, older: boolean): boolean {
  const text = context.presentation.recall(older, context.draft);
  if (text === null) return false;
  context.replaceDraft(text);
  return true;
}

function tab(context: KeyboardContext, shift: boolean): void {
  const completion =
    context.focus === "composer" && !shift
      ? completionFor(context.copy.commands, context.draft)
      : null;
  if (completion === null) context.focusOn(nextFocus(context.targets, context.focus, shift));
  else context.replaceDraft(completion);
}

/** Returns true only when a key is consumed; editor keys remain native. */
export function handleParityKey(
  key: Pick<KeyEvent, "name" | "ctrl" | "shift">,
  context: KeyboardContext,
): boolean {
  if (
    !["composer", "reason", "answer"].includes(context.focus) &&
    ["enter", "return", "space"].includes(key.name)
  ) {
    context.activate(context.focus);
    return true;
  }
  if (context.focus === "composer" && context.editor !== null && editComposer(key, context.editor))
    return true;
  const action = actionForKey(key, keyContext(context));
  if (action === null) return false;
  switch (action.type) {
    case "exit":
      context.dispatch({ type: "exit" });
      break;
    case "interrupt":
      context.dispatch({ type: "cancel" });
      break;
    case "approve":
      context.activate("approve");
      break;
    case "reject":
      context.activate("reject");
      break;
    case "toggle-last-output":
      scrollOutput(context, context.presentation.toggleLastOutput());
      break;
    case "toggle-turn-outputs":
      scrollOutput(context, context.presentation.toggleTurnOutputs());
      break;
    case "page-up":
      context.scroll?.scrollBy(-Math.max(1, context.height - 4));
      break;
    case "page-down":
      context.scroll?.scrollBy(Math.max(1, context.height - 4));
      break;
    case "history-older":
      return recall(context, true);
    case "history-newer":
      return recall(context, false);
    case "tab":
      tab(context, action.backwards);
      break;
  }
  return true;
}

function keyContext(context: KeyboardContext) {
  const editor = context.editor;
  const composing = context.focus === "composer";
  return {
    approvalKeys: context.approvalKeys,
    composerEmpty: composing && context.draft === "",
    composerFirstRow: composing && editor?.logicalCursor.row === 0,
    composerLastRow:
      composing && editor !== null && editor.logicalCursor.row === editor.lineCount - 1,
  };
}

function scrollOutput(context: KeyboardContext, id: string | null): void {
  if (id !== null) context.scroll?.scrollChildIntoView(id);
}
