/** @jsxImportSource @opentui/react */
import type { TextareaRenderable, TextareaAction } from "@opentui/core";
import type { Ref } from "react";

import type { CommandDescriptions } from "../../parity/copy.js";
import { wrapParts } from "../../parity/word-layout.js";
import { suggestionsFor } from "../../parity/commands.js";
import { GEOMETRY, PALETTE } from "../../parity/tokens.js";
import { ATTRIBUTES, leftSide, SOLID_LEFT } from "./theme.js";

/**
 * The composer and the strip of command suggestions above it.
 *
 * Editing stays available while the agent works — the border simply goes quiet
 * — so a student can write their next message without waiting.
 */

export interface ComposerKeyBinding {
  readonly action: TextareaAction;
  readonly ctrl?: boolean;
  readonly name: string;
  readonly shift?: boolean;
}

/**
 * Enter sends and a modified Enter adds a line. `return` and `enter` are both
 * bound because a terminal may report either name for the same key.
 */
export const COMPOSER_KEYS: readonly ComposerKeyBinding[] = Object.freeze([
  { action: "submit", name: "return" },
  { action: "submit", name: "enter" },
  { action: "newline", name: "return", shift: true },
  { action: "newline", name: "enter", shift: true },
  { action: "newline", ctrl: true, name: "j" },
  { action: "visual-line-home", name: "home" },
  { action: "visual-line-end", name: "end" },
  { action: "select-visual-line-home", name: "home", shift: true },
  { action: "select-visual-line-end", name: "end", shift: true },
  { action: "select-word-backward", name: "left", ctrl: true, shift: true },
  { action: "select-word-forward", name: "right", ctrl: true, shift: true },
  { action: "undo", name: "z", ctrl: true },
  { action: "redo", name: "y", ctrl: true },
  { action: "delete-line", name: "k", ctrl: true, shift: true },
  { action: "select-all", name: "f7" },
  { action: "visual-line-home", name: "a", ctrl: true },
  { action: "visual-line-end", name: "e", ctrl: true },
]);

export interface SuggestionsProperties {
  readonly columns?: number;
  readonly copy: CommandDescriptions;
  readonly text: string;
}

export function CommandSuggestions({ copy, text, columns = 120 }: SuggestionsProperties) {
  const suggestions = suggestionsFor(copy, text);
  if (suggestions.length === 0) return null;
  return (
    <box
      backgroundColor={PALETTE.surface}
      border={leftSide()}
      borderColor={PALETTE.accent}
      customBorderChars={SOLID_LEFT}
      flexShrink={0}
      marginLeft={1}
      marginRight={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <text wrapMode="word">
        {wrapParts(
          suggestions.flatMap((suggestion, index) => [
            { text: `${index === 0 ? "" : "   "}${suggestion.value}`, command: true },
            { text: `  ${suggestion.description}`, command: false },
          ]),
          columns - 8,
        ).map((part, index) => (
          <span
            key={String(index)}
            attributes={part.command ? ATTRIBUTES.bold : ATTRIBUTES.none}
            fg={part.command ? PALETTE.accent : PALETTE.mutedDim}
          >
            {part.text}
          </span>
        ))}
      </text>
    </box>
  );
}

export interface ComposerProperties {
  readonly focused?: boolean;
  readonly onFocus?: (() => void) | undefined;
  /** False while a turn runs, which quiets the border without locking the keys. */
  readonly canSubmit: boolean;
  readonly disabled: boolean;
  /** The editor itself, so the session can read the draft and recall history. */
  readonly editor: Ref<TextareaRenderable>;
  readonly onContentChange: () => void;
  readonly onSubmit: () => void;
  readonly placeholder: string;
}

export function Composer({
  focused,
  onFocus,
  canSubmit,
  disabled,
  editor,
  onContentChange,
  onSubmit,
  placeholder,
}: ComposerProperties) {
  return (
    <referenceBox
      backgroundColor={PALETTE.surface}
      border
      referenceBorder={!disabled && (focused ?? true) ? "tall" : null}
      borderColor={canSubmit && !disabled ? PALETTE.accent : PALETTE.panel}
      flexShrink={0}
      marginLeft={1}
      marginRight={1}
      maxHeight={GEOMETRY.composerMaxRows}
      minHeight={GEOMETRY.composerMinRows}
      paddingLeft={1}
      paddingRight={1}
    >
      <textarea
        backgroundColor={PALETTE.surface}
        textColor={PALETTE.textOnSurface}
        placeholderColor={PALETTE.placeholder}
        focused={!disabled && (focused ?? true)}
        onMouseDown={() => onFocus?.()}
        keyBindings={[...COMPOSER_KEYS]}
        onContentChange={onContentChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
        ref={editor}
      />
    </referenceBox>
  );
}
