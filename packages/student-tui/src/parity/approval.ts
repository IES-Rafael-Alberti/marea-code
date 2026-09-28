import { fill, type ApprovalCopy } from "./copy.js";

/**
 * The inline authorization of a tool that would change the student's work.
 *
 * The compact preview is what the runtime already formatted. The full preview
 * is reconstructed here for the two operations whose compact form hides the
 * thing that matters — the content being written, and the text being replaced —
 * so that a student can see the whole change before allowing it.
 */

/** The arguments an approval is allowed to show. */
interface ApprovalArguments {
  readonly content?: string | undefined;
  readonly filePath?: string | undefined;
  readonly newString?: string | undefined;
  readonly oldString?: string | undefined;
  readonly replaceAll?: boolean | undefined;
}

export interface ApprovalRequest {
  readonly arguments: ApprovalArguments;
  readonly interruptId: string;
  readonly name: string;
  /** Already formatted by the runtime: a diff, a command, a path. */
  readonly preview: string;
  readonly warnings: readonly string[];
}

type ApprovalDecision =
  | { readonly type: "approve" }
  | { readonly type: "reject"; readonly reason: string }
  | { readonly type: "cancel" };

type ApprovalStage = "deciding" | "rejecting" | "resolved";

export interface ApprovalState {
  readonly decision: ApprovalDecision | null;
  readonly expanded: boolean;
  readonly reason: string;
  readonly request: ApprovalRequest;
  readonly stage: ApprovalStage;
}

export function openApproval(request: ApprovalRequest): ApprovalState {
  return { decision: null, expanded: false, reason: "", request, stage: "deciding" };
}

function writePreview(args: ApprovalArguments, copy: ApprovalCopy): string {
  const content = args.content ?? "";
  const count = content === "" ? 0 : content.split("\n").length;
  return `${args.filePath ?? ""}  (${copy.lines(count)})\n\n${content}`;
}

function editPreview(args: ApprovalArguments, copy: ApprovalCopy): string {
  const scope = args.replaceAll === true ? copy.editAll : copy.editOne;
  const before = `${copy.editBefore}\n${args.oldString ?? ""}`;
  const after = `${copy.editAfter}\n${args.newString ?? ""}`;
  return `${args.filePath ?? ""}  (${scope})\n\n${before}\n\n${after}`;
}

/** The preview without any elision, for the operations that need one. */
export function fullPreview(request: ApprovalRequest, copy: ApprovalCopy): string {
  if (request.name === "write_file") return writePreview(request.arguments, copy);
  if (request.name === "edit_file") return editPreview(request.arguments, copy);
  return request.preview;
}

/** Whether the preview has more to show than its compact form. */
export function previewExpandable(request: ApprovalRequest, copy: ApprovalCopy): boolean {
  return fullPreview(request, copy) !== request.preview;
}

export interface ApprovalView {
  readonly actionsVisible: boolean;
  readonly outcome: string | null;
  readonly preview: string;
  readonly previewToggle: string | null;
  readonly reasonVisible: boolean;
  readonly title: string;
  readonly warnings: readonly string[];
}

function outcomeLabel(decision: ApprovalDecision, copy: ApprovalCopy): string {
  if (decision.type === "approve") return copy.approved;
  if (decision.type === "cancel") return copy.cancelled;
  return decision.reason === ""
    ? copy.rejected
    : fill(copy.rejectedWithReason, { reason: decision.reason });
}

export function approvalView(state: ApprovalState, copy: ApprovalCopy): ApprovalView {
  const resolved = state.stage === "resolved";
  const expandable = previewExpandable(state.request, copy);
  return {
    actionsVisible: !resolved,
    outcome: state.decision === null ? null : outcomeLabel(state.decision, copy),
    preview: state.expanded ? fullPreview(state.request, copy) : state.request.preview,
    previewToggle: expandable ? (state.expanded ? copy.collapse : copy.expand) : null,
    reasonVisible: state.stage === "rejecting",
    title: fill(copy.title, { name: state.request.name }),
    warnings: state.request.warnings,
  };
}

export type ApprovalAction =
  | { readonly type: "approve" }
  | { readonly type: "start-reject" }
  | { readonly type: "set-reason"; readonly reason: string }
  | { readonly type: "confirm-reject" }
  | { readonly type: "cancel" }
  | { readonly type: "toggle-preview" };

function resolve(state: ApprovalState, decision: ApprovalDecision): ApprovalState {
  return { ...state, decision, stage: "resolved" };
}

/**
 * Applies one action. A resolved approval ignores everything, which is what
 * keeps a second Enter, a late key or a stale click from deciding twice.
 */
export function approvalReducer(state: ApprovalState, action: ApprovalAction): ApprovalState {
  if (state.stage === "resolved") return state;
  switch (action.type) {
    case "approve":
      return resolve(state, { type: "approve" });
    case "start-reject":
      return { ...state, stage: "rejecting" };
    case "set-reason":
      // The input reports its value on every render; only a real edit is a change.
      return action.reason === state.reason ? state : { ...state, reason: action.reason };
    case "confirm-reject":
      return resolve(state, { reason: state.reason.trim(), type: "reject" });
    case "cancel":
      return resolve(state, { type: "cancel" });
    default:
      return { ...state, expanded: !state.expanded };
  }
}
