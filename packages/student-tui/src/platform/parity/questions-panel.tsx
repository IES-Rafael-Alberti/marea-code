/** @jsxImportSource @opentui/react */
import { ReferenceInput, ReferenceButton } from "./reference-controls.js";
import type { ParityInteraction } from "./interaction.js";
import type { QuestionCopy } from "../../parity/copy.js";
import {
  enterAction,
  questionsView,
  type QuestionsAction,
  type QuestionsState,
} from "../../parity/questions.js";
import { PALETTE } from "../../parity/tokens.js";
import { InlinePanel } from "./panel.js";
import { ATTRIBUTES } from "./theme.js";

/**
 * The agent's questions, answered one at a time in a single field that takes
 * either a choice number or the student's own words.
 */

export interface QuestionsPanelProperties {
  readonly id?: string | undefined;
  readonly interaction?: ParityInteraction | undefined;
  readonly copy: QuestionCopy;
  readonly onAction: (action: QuestionsAction) => void;
  readonly state: QuestionsState;
}

export function QuestionsPanel({
  copy,
  onAction,
  state,
  interaction,
  id,
}: QuestionsPanelProperties) {
  const view = questionsView(state, copy);
  const navigationVisible = view.nextVisible || view.sendVisible;
  return (
    <InlinePanel id={id} resolved={state.resolved}>
      <text attributes={ATTRIBUTES.bold} fg={PALETTE.accent}>
        {view.title}
      </text>
      <text fg={PALETTE.dimOnSurface} marginTop={1}>
        {view.progress}
      </text>
      <text attributes={ATTRIBUTES.bold} fg={PALETTE.textOnSurface} marginTop={1}>
        {view.text}
        {view.required ? " *" : ""}
      </text>
      {view.choices.length === 0 ? null : (
        <box flexDirection="column" marginTop={1}>
          {view.choices.map((choice, index) => (
            <text fg={PALETTE.dimOnSurface} key={choice}>
              {`   ${String(index + 1)}) ${choice}`}
            </text>
          ))}
        </box>
      )}
      <ReferenceInput
        readOnly={state.resolved}
        focused={!state.resolved && (interaction === undefined || interaction.focus === "answer")}
        onMouseDown={() => interaction?.focusOn("answer")}
        maxLength={4_096}
        onInput={(value: string) => {
          onAction({ type: "type", value });
        }}
        onSubmit={() => {
          onAction(enterAction(state));
        }}
        placeholder={copy.placeholder}
        value={view.answer}
      />
      {state.resolved ? null : (
        <text fg={PALETTE.warning} marginTop={1} minHeight={1}>
          {view.error ?? ""}
        </text>
      )}
      {navigationVisible ? (
        <box flexDirection="row" marginTop={1}>
          <ReferenceButton
            label={copy.previous}
            background={PALETTE.surface}
            focused={interaction?.focus === "previous"}
            disabled={!view.previousEnabled}
            onPress={() => {
              onAction({ type: "previous" });
            }}
          />
          <ReferenceButton
            label={view.sendVisible ? copy.send : copy.next}
            background={PALETTE.buttonPrimary}
            focused={interaction?.focus === "next"}
            onPress={() => {
              onAction(view.sendVisible ? { type: "submit" } : { type: "next" });
            }}
          />
        </box>
      ) : null}
      <text fg={PALETTE.dimOnSurface} minHeight={1}>
        {view.outcome ?? ""}
      </text>
    </InlinePanel>
  );
}
