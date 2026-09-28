/** @jsxImportSource @opentui/react */
import { pointerAction } from "./pointer-action.js";
import type { ToolCopy } from "../../parity/copy.js";
import { GEOMETRY, PALETTE } from "../../parity/tokens.js";
import { toolHeader, toolOutput, toolSummary, type ToolRow } from "../../parity/tool.js";
import { ASCII_LEFT, ATTRIBUTES, leftSide, TOOL_GLYPHS, toolColour } from "./theme.js";

/**
 * One tool call. Closed it is a single line; open it is the output, bounded so
 * that a long result scrolls inside its own box instead of burying the answer.
 */

export interface ToolRowProperties {
  readonly id?: string | undefined;
  readonly onToggle?: (() => void) | undefined;
  readonly copy: ToolCopy;
  readonly focused: boolean;
  readonly row: ToolRow;
}

export function ToolRowView({ copy, focused, row, onToggle, id }: ToolRowProperties) {
  const header = toolHeader(row, copy);
  const summary = row.expanded ? null : toolSummary(row, copy);
  const colour = toolColour(header.glyph);
  const dim =
    header.glyph === "failed"
      ? PALETTE.warningDim
      : header.glyph === "done"
        ? PALETTE.depthDim
        : PALETTE.accentDim;
  return (
    <box
      {...(id === undefined ? {} : { id })}
      {...pointerAction(() => onToggle?.())}
      backgroundColor={focused ? PALETTE.surface : PALETTE.background}
      border={leftSide()}
      borderColor={header.glyph === "failed" ? PALETTE.warning : PALETTE.panel}
      customBorderChars={ASCII_LEFT}
      flexDirection="column"
      marginBottom={1}
    >
      <box paddingLeft={2} paddingRight={2}>
        <text fg={colour}>
          <span fg={colour}>{TOOL_GLYPHS[header.glyph]} </span>
          <span attributes={ATTRIBUTES.bold}>{header.label}</span>
          {header.summary === "" ? null : <span fg={dim}>{`  ${header.summary}`}</span>}
          {header.marker === null ? null : <span fg={dim}>{`    ${header.marker}`}</span>}
        </text>
      </box>
      {summary === null ? null : (
        <box
          flexDirection="column"
          marginLeft={2}
          marginRight={1}
          backgroundColor={PALETTE.surface}
          marginTop={1}
          maxHeight={GEOMETRY.summaryMaxRows}
          paddingLeft={1}
          paddingRight={1}
        >
          {summary.omitted === null ? null : <text fg={PALETTE.dim}>{summary.omitted}</text>}
          {summary.lines.map((line, index) => (
            <text fg={PALETTE.muted} key={`l-${String(index)}`}>
              {line}
            </text>
          ))}
          {summary.hint === null ? null : (
            <text attributes={ATTRIBUTES.italic} fg={PALETTE.mutedDim}>
              {summary.hint}
            </text>
          )}
        </box>
      )}
      {row.expanded && row.outcome !== null ? (
        <referenceScrollbox
          backgroundColor={PALETTE.surface}
          border
          borderColor={PALETTE.panel}
          marginLeft={2}
          marginRight={1}
          marginTop={1}
          contentBottomInset={3}
          flexGrow={0}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <text flexShrink={0} fg={PALETTE.textOnSurface}>
            {toolOutput(row.outcome, copy, row.call.name)}
          </text>
        </referenceScrollbox>
      ) : null}
    </box>
  );
}
