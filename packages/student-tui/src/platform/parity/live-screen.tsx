import type { ReferenceConversation } from "../adaptive-scrollbox.boundary.js";
/** @jsxImportSource @opentui/react */
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import type { ConversationAction } from "../../conversation-contracts.js";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { ApprovalAction } from "../../parity/approval.js";
import { handleParityKey } from "./keyboard.js";
import type { ParityCopy } from "../../parity/copy.js";
import { defaultFocus, focusTargets } from "../../parity/navigation.js";
import type { Presentation } from "../../parity/presentation.js";
import { enterAction, type QuestionsAction } from "../../parity/questions.js";
import { PALETTE } from "../../parity/tokens.js";
import { useActivityClock } from "./activity-clock.js";
import { ClipboardNotice } from "./clipboard-notice.js";
import { ParityScreen } from "./parity-screen.js";

export function LiveParityScreen({
  copy,
  presentation,
  onAction,
}: {
  readonly copy: ParityCopy;
  readonly presentation: Presentation;
  readonly onAction: (action: ConversationAction) => void;
}) {
  const { width, height } = useTerminalDimensions();
  const editor = useRef<TextareaRenderable | null>(null);
  const scroll = useRef<ReferenceConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [, update] = useState(0);
  const [style] = useState(() =>
    SyntaxStyle.fromStyles({
      default: { fg: PALETTE.text },
      "markup.heading": { fg: PALETTE.focusRing, underline: true },
      "markup.raw": { fg: "#f4bb6e", bg: "#241d13" },
      "markup.link": { fg: PALETTE.link, underline: true },
      "markup.strong": { fg: PALETTE.text, bold: true },
      "markup.italic": { fg: PALETTE.text, italic: true },
      "markup.list": { fg: PALETTE.link },
    }),
  );
  const [selection, select] = useState<{
    pendingId: string | null;
    stage: string | null;
    id: string;
  } | null>(null);
  useEffect(
    () => () => {
      style.destroy();
    },
    [style],
  );
  const session = presentation.snapshot();
  const status = useActivityClock(session.status);
  const pending = session.transcript.find((entry) => entry.id === session.pendingId);
  const stage = pending?.kind === "approval" ? pending.approval.stage : null;
  const targets = focusTargets(session);
  const focus =
    selection !== null &&
    selection.pendingId === session.pendingId &&
    selection.stage === stage &&
    targets.includes(selection.id)
      ? selection.id
      : defaultFocus(session);
  const refresh = () => {
    update((version) => version + 1);
  };
  const focusOn = (id: string) => {
    select({ pendingId: session.pendingId, stage, id });
    const entryId =
      id.startsWith("tool:") || id.startsWith("retry:")
        ? id.slice(id.indexOf(":") + 1)
        : session.pendingId;
    if (entryId !== null) scroll.current?.scrollChildIntoView(entryId);
  };
  const approve = (action: ApprovalAction) => {
    presentation.approve(action);
    refresh();
  };
  const answer = (action: QuestionsAction) => {
    const decision = presentation.questions(action);
    select(null);
    refresh();
    if (decision === null) return;
    if (decision.type === "answers")
      onAction({ type: "answers", interruptId: decision.interruptId, values: decision.values });
    else onAction({ type: "cancel" });
  };
  const activate = (id: string) => {
    focusOn(id);
    if (id.startsWith("tool:")) presentation.toggleTool(id.slice(5));
    else if (id.startsWith("retry:")) presentation.retry();
    else if (id === "preview") approve({ type: "toggle-preview" });
    else if (id === "approve") approve({ type: "approve" });
    else if (id === "reject") approve({ type: "start-reject" });
    else if (id === "previous") answer({ type: "previous" });
    else if (id === "next" && pending?.kind === "questions") answer(enterAction(pending.questions));
    refresh();
  };
  const replaceDraft = (text: string) => {
    editor.current?.setText(text);
    editor.current?.gotoBufferEnd();
    setDraft(text);
  };
  useKeyboard((key) => {
    if (
      handleParityKey(key, {
        approvalKeys: pending?.kind === "approval" && pending.approval.stage === "deciding",
        copy,
        draft: editor.current?.plainText ?? draft,
        editor: editor.current,
        focus,
        height,
        presentation,
        scroll: scroll.current,
        targets,
        activate,
        dispatch: onAction,
        focusOn,
        replaceDraft,
      })
    ) {
      key.preventDefault();
      refresh();
    }
  });
  return (
    <ParityScreen
      overlay={<ClipboardNotice text={copy.notices.clipboard} quitHint={copy.notices.quitHint} />}
      columns={width}
      copy={copy}
      draft={draft}
      editor={editor}
      focusedToolId={null}
      markdownStyle={style}
      onApproval={approve}
      onQuestions={answer}
      interaction={{ focus, scroll, focusOn, activate }}
      onContentChange={() => {
        setDraft(editor.current?.plainText ?? "");
      }}
      onSubmit={() => {
        const current = editor.current;
        if (current !== null && presentation.submit(current.plainText)) replaceDraft("");
        refresh();
      }}
      session={{ ...session, status }}
    />
  );
}
