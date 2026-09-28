/**
 * What a key means, given what is on screen.
 *
 * Kept apart from the components so that the whole keyboard can be reasoned
 * about — and tested — in one place, the way the reference's binding table can.
 */

export type ParityAction =
  | { readonly type: "exit" }
  | { readonly type: "interrupt" }
  | { readonly type: "toggle-last-output" }
  | { readonly type: "toggle-turn-outputs" }
  | { readonly type: "page-up" }
  | { readonly type: "page-down" }
  | { readonly type: "approve" }
  | { readonly type: "reject" }
  | { readonly type: "tab"; readonly backwards: boolean }
  | { readonly type: "history-older" }
  | { readonly type: "history-newer" };

export interface KeyPress {
  readonly ctrl: boolean;
  readonly name: string;
  readonly shift: boolean;
}

export interface KeyContext {
  /** True when an approval is waiting and the focus is not inside a field. */
  readonly approvalKeys: boolean;
  /** True when the composer holds nothing at all. */
  readonly composerEmpty: boolean;
  /** True when the cursor sits on the first row of the composer. */
  readonly composerFirstRow: boolean;
  /** True when the cursor sits on the last row of the composer. */
  readonly composerLastRow: boolean;
}

const PLAIN = new Map<string, ParityAction>([
  ["escape", { type: "interrupt" }],
  ["pagedown", { type: "page-down" }],
  ["pageup", { type: "page-up" }],
]);

const WITH_CTRL = new Map<string, ParityAction>([
  ["q", { type: "exit" }],
  ["d", { type: "exit" }],
  ["o", { type: "toggle-last-output" }],
]);

function approvalAction(key: KeyPress): ParityAction | null {
  if (key.name === "y") return { type: "approve" };
  return key.name === "n" ? { type: "reject" } : null;
}

/** The action a key stands for, or null when the composer should keep it. */
export function actionForKey(key: KeyPress, context: KeyContext): ParityAction | null {
  if (key.shift && key.name !== "tab") return null;
  if (key.ctrl) {
    if (key.name === "e") return context.composerEmpty ? { type: "toggle-turn-outputs" } : null;
    return WITH_CTRL.get(key.name) ?? null;
  }
  if (context.approvalKeys) {
    const decision = approvalAction(key);
    if (decision !== null) return decision;
  }
  if (key.name === "tab") return { type: "tab", backwards: key.shift };
  if (key.name === "up" && context.composerFirstRow) return { type: "history-older" };
  if (key.name === "down" && context.composerLastRow) return { type: "history-newer" };
  return PLAIN.get(key.name) ?? null;
}
