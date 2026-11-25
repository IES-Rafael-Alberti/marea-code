/** @jsxImportSource @opentui/react */
import { pointerAction } from "./pointer-action.js";
import { ReferenceInput, ReferenceButton } from "./reference-controls.js";
import type { ParityInteraction } from "./interaction.js";
import { approvalView, type ApprovalAction, type ApprovalState } from "../../parity/approval.js";
import type { ApprovalCopy } from "../../parity/copy.js";
import { PALETTE } from "../../parity/tokens.js";
import { InlinePanel } from "./panel.js";
import { ATTRIBUTES } from "./theme.js";

/**
 * The inline authorization. It stays on screen after the decision, disabled
 * and with its outcome, so the student can see afterwards what they allowed.
 */

export interface ApprovalPanelProperties {
  readonly id?: string | undefined;
  readonly interaction?: ParityInteraction | undefined;
  readonly copy: ApprovalCopy;
  readonly onAction: (action: ApprovalAction) => void;
  readonly state: ApprovalState;
}

/** One line per action of the batch that comes after this one. */
function RemainingActions({
  heading,
  lines,
}: {
  readonly heading: string;
  readonly lines: readonly string[];
}) {
  if (lines.length === 0) return null;
  return (
    <text fg={PALETTE.dimOnSurface} marginBottom={1}>
      {[heading, ...lines.map((line) => `  · ${line}`)].join("\n")}
    </text>
  );
}

function ApproveAllButton({
  focused,
  label,
  onAction,
}: {
  readonly focused: boolean;
  readonly label: string;
  readonly onAction: (action: ApprovalAction) => void;
}) {
  return (
    <ReferenceButton
      label={`${label} `}
      background={focused ? PALETTE.buttonApproveFocused : PALETTE.buttonApprove}
      focused={focused}
      onPress={() => {
        onAction({ type: "approve-all" });
      }}
    />
  );
}

export function ApprovalPanel({ copy, onAction, state, interaction, id }: ApprovalPanelProperties) {
  const view = approvalView(state, copy);
  const resolved = !view.actionsVisible;
  return (
    <InlinePanel id={id} resolved={resolved}>
      <text attributes={ATTRIBUTES.bold} fg={PALETTE.warning}>
        {view.position === null ? view.title : `${view.title} · ${view.position}`}
      </text>
      {view.preview === "" ? null : (
        <referenceScrollbox
          border={interaction?.focus === "preview" ? ["left"] : []}
          borderColor={PALETTE.accent}
          backgroundColor={PALETTE.background}
          marginBottom={1}
          marginTop={1}
          flexGrow={0}
          paddingLeft={1}
          paddingRight={1}
        >
          <text flexShrink={0} fg={PALETTE.text}>
            {view.preview}
          </text>
          {view.previewToggle === null ? null : (
            <text
              flexShrink={0}
              marginTop={1}
              fg={PALETTE.dimOnSurface}
              {...pointerAction(() => {
                onAction({ type: "toggle-preview" });
              })}
            >
              {view.previewToggle}
            </text>
          )}
        </referenceScrollbox>
      )}
      <RemainingActions
        heading={copy.remaining}
        lines={view.actionsVisible ? view.remaining : []}
      />
      {view.warnings.map((warning) => (
        <text fg={PALETTE.warning} key={warning} marginBottom={1}>
          ⚠ {warning}
        </text>
      ))}
      {view.actionsVisible ? (
        <box
          flexDirection="row"
          marginTop={view.preview !== "" || view.warnings.length > 0 ? 0 : 1}
        >
          <ReferenceButton
            label={`${copy.approve} `}
            background={
              interaction?.focus === "approve"
                ? PALETTE.buttonApproveFocused
                : PALETTE.buttonApprove
            }
            focused={interaction?.focus === "approve"}
            onPress={() => {
              onAction({ type: "approve" });
            }}
          />
          {view.approveAllVisible ? (
            <ApproveAllButton
              label={copy.approveAll}
              focused={interaction?.focus === "approve-all"}
              onAction={onAction}
            />
          ) : null}
          <ReferenceButton
            label={`${copy.reject} `}
            background={PALETTE.buttonReject}
            focused={interaction?.focus === "reject"}
            onPress={() => {
              onAction({ type: "start-reject" });
            }}
          />
        </box>
      ) : null}
      {view.reasonVisible ? (
        <ReferenceInput
          focused={interaction === undefined || interaction.focus === "reason"}
          onMouseDown={() => interaction?.focusOn("reason")}
          maxLength={2_048}
          onInput={(value: string) => {
            onAction({ reason: value, type: "set-reason" });
          }}
          onSubmit={() => {
            onAction({ type: "confirm-reject" });
          }}
          placeholder={copy.reasonPlaceholder}
          value={state.reason}
        />
      ) : null}
      <text fg={PALETTE.dimOnSurface} minHeight={1}>
        {view.outcome ?? ""}
      </text>
    </InlinePanel>
  );
}
