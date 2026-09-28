/** @jsxImportSource @opentui/react */
import type { ParityInteraction } from "./interaction.js";
import type { SyntaxStyle, TextareaRenderable } from "@opentui/core";
import type { Ref, ReactNode } from "react";

import type { ApprovalAction } from "../../parity/approval.js";
import type { ParityCopy } from "../../parity/copy.js";
import type { QuestionsAction } from "../../parity/questions.js";
import type { SessionState } from "../../parity/session-state.js";
import { PALETTE } from "../../parity/tokens.js";
import { Composer, CommandSuggestions } from "./composer.js";
import { Conversation } from "./conversation.js";
import { StatusBar } from "./status-bar.js";

/**
 * The whole screen: conversation, suggestions, composer, status bar.
 *
 * It renders a value and reports intent; nothing here decides anything. The
 * session state it is given is the single source for what the student sees.
 */

export interface ParityScreenProperties {
  readonly overlay?: ReactNode;
  readonly interaction?: ParityInteraction | undefined;
  readonly columns: number;
  readonly copy: ParityCopy;
  readonly draft: string;
  readonly editor: Ref<TextareaRenderable>;
  readonly focusedToolId: string | null;
  readonly markdownStyle: SyntaxStyle;
  readonly onApproval: (action: ApprovalAction) => void;
  readonly onContentChange: () => void;
  readonly onQuestions: (action: QuestionsAction) => void;
  readonly onSubmit: () => void;
  readonly session: SessionState;
}

export function ParityScreen({
  overlay,
  interaction,
  columns,
  copy,
  draft,
  editor,
  focusedToolId,
  markdownStyle,
  onApproval,
  onContentChange,
  onQuestions,
  onSubmit,
  session,
}: ParityScreenProperties) {
  return (
    <box backgroundColor={PALETTE.background} flexDirection="column" flexGrow={1}>
      {session.starting ? (
        <box flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text fg={PALETTE.dim}>{copy.preparing}</text>
        </box>
      ) : (
        <Conversation
          interaction={interaction}
          columns={columns}
          copy={copy}
          focusedToolId={focusedToolId}
          markdownStyle={markdownStyle}
          onApproval={onApproval}
          onQuestions={onQuestions}
          transcript={session.transcript}
        />
      )}
      <CommandSuggestions copy={copy.commands} text={draft} columns={columns} />
      <Composer
        {...(interaction === undefined
          ? {}
          : {
              focused: interaction.focus === "composer",
              onFocus: () => {
                interaction.focusOn("composer");
              },
            })}
        canSubmit={!session.turnActive}
        disabled={session.starting || session.fatal || session.pendingId !== null}
        editor={editor}
        onContentChange={onContentChange}
        onSubmit={onSubmit}
        placeholder={copy.composerPlaceholder}
      />
      <StatusBar columns={columns} copy={copy} status={session.status} />
      {overlay}
    </box>
  );
}
