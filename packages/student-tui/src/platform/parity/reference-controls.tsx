/** @jsxImportSource @opentui/react */
import { buttonStyle } from "./button-style.js";
import { pointerAction, type PointerOrigin } from "./pointer-action.js";
import type { InputProps } from "@opentui/react";
import { PALETTE } from "../../parity/tokens.js";
import { ATTRIBUTES } from "./theme.js";

type InputProperties = InputProps & { readonly readOnly?: boolean };
export function ReferenceInput(properties: InputProperties) {
  const value = properties.value ?? "";
  return (
    <referenceBox
      border
      referenceBorder="tall"
      borderColor={
        properties.readOnly
          ? PALETTE.inputDisabledBorder
          : properties.focused
            ? PALETTE.focusRing
            : PALETTE.panel
      }
      backgroundColor={PALETTE.surface}
      height={3}
      flexShrink={0}
      marginTop={1}
    >
      <box
        height={1}
        width="100%"
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={properties.readOnly ? PALETTE.surface : PALETTE.inputBackground}
      >
        {properties.readOnly ? (
          <text fg={value !== "" ? PALETTE.muted : PALETTE.inputDisabledPlaceholder}>
            {value === "" ? properties.placeholder : value}
          </text>
        ) : (
          <input
            {...properties}
            backgroundColor={PALETTE.inputBackground}
            textColor={PALETTE.text}
            placeholderColor={PALETTE.inputPlaceholder}
          />
        )}
      </box>
    </referenceBox>
  );
}

export function ReferenceButton({
  label,
  background,
  focused,
  disabled = false,
  onPress,
  minWidth = 16,
}: {
  readonly label: string;
  readonly background: string;
  readonly focused: boolean;
  readonly disabled?: boolean;
  readonly minWidth?: number;
  readonly onPress: () => void;
}) {
  let button: { referencePressed: boolean; referencePointerOrigin: PointerOrigin } | null = null;
  let origin: PointerOrigin = null;
  const pointer = pointerAction(
    () => {
      if (!disabled) onPress();
    },
    (pressed) => {
      if (button !== null) button.referencePressed = pressed && !disabled;
    },
    {
      get origin() {
        return button === null ? origin : button.referencePointerOrigin;
      },
      set origin(value: PointerOrigin) {
        if (button === null) origin = value;
        else button.referencePointerOrigin = value;
      },
    },
  );
  const style = buttonStyle(background, disabled);
  return (
    <referenceBox
      border={["top", "bottom"]}
      referenceBorder="button"
      referencePressed={false}
      ref={(node) => {
        button = node;
      }}
      borderColor={style.edge}
      referenceBottomColor={style.bottom}
      backgroundColor={background}
      width={Math.max(minWidth, label.length + 2)}
      height={3}
      alignItems="center"
      marginRight={1}
      {...pointer}
    >
      <text
        onMouseOut={pointer.onMouseOut}
        onMouseDragEnd={pointer.onMouseDragEnd}
        attributes={ATTRIBUTES.bold}
        fg={focused ? background : style.text}
        bg={focused ? style.text : background}
      >
        {label}
      </text>
    </referenceBox>
  );
}
