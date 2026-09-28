/** @jsxImportSource @opentui/react */
import { ReferenceButton } from "./reference-controls.js";
import type { ParityInteraction } from "./interaction.js";
import type { SyntaxStyle } from "@opentui/core";

import type { ApprovalAction } from "../../parity/approval.js";
import type { ParityCopy } from "../../parity/copy.js";
import type { QuestionsAction } from "../../parity/questions.js";
import { PALETTE } from "../../parity/tokens.js";
import type { Transcript, TranscriptEntry } from "../../parity/transcript.js";
import { ApprovalPanel } from "./approval-panel.js";
import { Banner } from "./banner.js";
import { QuestionsPanel } from "./questions-panel.js";
import { ATTRIBUTES, leftSide, WIDE_LEFT } from "./theme.js";
import { ToolRowView } from "./tool-row.js";

/**
 * The transcript. Every entry keeps the shape it had when it happened, so
 * scrolling back shows what the student actually saw and decided.
 */

export interface ConversationProperties {
  readonly interaction?: ParityInteraction | undefined;
  readonly columns: number;
  readonly copy: ParityCopy;
  readonly focusedToolId: string | null;
  readonly markdownStyle: SyntaxStyle;
  readonly onApproval: (action: ApprovalAction) => void;
  readonly onQuestions: (action: QuestionsAction) => void;
  readonly transcript: Transcript;
}

function UserMessage({ text }: { readonly text: string }) {
  return (
    <box
      border={leftSide()}
      borderColor={PALETTE.accent}
      customBorderChars={WIDE_LEFT}
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={PALETTE.accent} attributes={ATTRIBUTES.bold}>
        <span attributes={ATTRIBUTES.bold} fg={PALETTE.accent}>
          {"> "}
        </span>
        {text}
      </text>
    </box>
  );
}

function ConversationEntry({
  interaction,
  columns,
  copy,
  entry,
  focusedToolId,
  markdownStyle,
  onApproval,
  onQuestions,
}: Omit<ConversationProperties, "transcript"> & { readonly entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "banner":
      return <Banner columns={columns} context={entry.context} copy={copy.banner} />;
    case "user":
      return <UserMessage text={entry.text} />;
    case "assistant":
      return (
        <box marginBottom={1} paddingLeft={1} paddingRight={1}>
          <referenceMarkdown
            content={entry.text}
            streaming={entry.streaming}
            syntaxStyle={markdownStyle}
          />
        </box>
      );
    case "reasoning":
      return (
        <box marginBottom={1} paddingLeft={2} paddingRight={2}>
          <text attributes={ATTRIBUTES.italic} fg={PALETTE.dim}>
            {entry.text.trim()}
          </text>
        </box>
      );
    case "tool":
      return renderTool(entry, copy, focusedToolId, interaction);
    case "approval":
      return (
        <ApprovalPanel
          id={entry.id}
          interaction={interaction}
          copy={copy.approval}
          onAction={onApproval}
          state={entry.approval}
        />
      );
    case "questions":
      return (
        <QuestionsPanel
          id={entry.id}
          interaction={interaction}
          copy={copy.question}
          onAction={onQuestions}
          state={entry.questions}
        />
      );
    case "error":
      return (
        <box
          id={entry.id}
          border
          borderColor={PALETTE.warning}
          flexDirection="column"
          marginBottom={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
        >
          <text attributes={ATTRIBUTES.bold} fg={PALETTE.warning}>
            {entry.message}
          </text>
          {entry.detail === "" ? null : (
            <text fg={PALETTE.warningDim} attributes={ATTRIBUTES.bold}>
              {entry.detail}
            </text>
          )}
          {entry.retryable ? (
            <box marginTop={1}>
              <ReferenceButton
                label={entry.retryOffered ? copy.turn.retry : copy.turn.retryStarted}
                minWidth={24}
                background={entry.retryOffered ? PALETTE.surface : PALETTE.buttonRetryDisabled}
                focused={interaction?.focus === `retry:${entry.id}`}
                disabled={!entry.retryOffered}
                onPress={() => interaction?.activate(`retry:${entry.id}`)}
              />
            </box>
          ) : null}
        </box>
      );
    default:
      return entry.tone === "help" ? (
        <box marginBottom={1} paddingLeft={1} paddingRight={1}>
          <referenceMarkdown content={entry.text} streaming syntaxStyle={markdownStyle} />
        </box>
      ) : (
        <text attributes={ATTRIBUTES.italic} fg={PALETTE.dim}>
          {entry.text}
        </text>
      );
  }
}

export function Conversation(properties: ConversationProperties) {
  const { transcript, ...rest } = properties;
  return (
    <referenceConversation
      {...(properties.interaction === undefined ? {} : { ref: properties.interaction.scroll })}
      marginRight={2}
      contentOptions={{ minHeight: "100%", justifyContent: "flex-end" }}
      verticalScrollbarOptions={{
        width: 1,
        trackOptions: {
          foregroundColor: PALETTE.scrollThumb,
          backgroundColor: PALETTE.scrollTrack,
        },
      }}
      stickyScroll
      stickyStart="bottom"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      {transcript.map((entry) => (
        <ConversationEntry key={entry.id} {...rest} entry={entry} />
      ))}
    </referenceConversation>
  );
}

function renderTool(
  entry: Extract<TranscriptEntry, { kind: "tool" }>,
  copy: ParityCopy,
  focusedToolId: string | null,
  interaction?: ParityInteraction,
) {
  return (
    <ToolRowView
      id={entry.id}
      copy={copy.tool}
      focused={interaction?.focus === `tool:${entry.id}` || entry.id === focusedToolId}
      row={entry.row}
      {...(interaction === undefined
        ? {}
        : {
            onToggle: () => {
              interaction.activate(`tool:${entry.id}`);
            },
          })}
    />
  );
}
