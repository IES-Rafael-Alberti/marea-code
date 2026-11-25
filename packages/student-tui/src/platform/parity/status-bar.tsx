/** @jsxImportSource @opentui/react */
import { fittingWords } from "../../parity/word-layout.js";
import type { ParityCopy } from "../../parity/copy.js";
import { statusLine, type StatusState } from "../../parity/status.js";
import { PALETTE } from "../../parity/tokens.js";
import { ATTRIBUTES } from "./theme.js";

/**
 * The single row under the composer. What the session is doing comes first and
 * in colour while it is working; the keys and the context follow, dimmed, so
 * they never compete with the conversation.
 */

export interface StatusBarProperties {
  readonly columns?: number;
  readonly copy: ParityCopy;
  readonly status: StatusState;
  /** The `/usage` line, kept at the right end while it is shown. */
  readonly usage?: string | null;
}

const GAP = "    ";

export function StatusBar({ copy, status, columns = 120, usage = null }: StatusBarProperties) {
  const line = statusLine(status, copy);
  const usageWidth = usage === null ? 0 : usage.length + GAP.length;
  const width = columns - 4 - usageWidth;
  const elapsedWidth = line.elapsed === "" ? 0 : line.elapsed.length + 1;
  const hint = fittingWords(line.hint, width - line.label.length - elapsedWidth - GAP.length);
  const context =
    hint !== line.hint
      ? ""
      : fittingWords(
          line.context,
          width -
            line.label.length -
            elapsedWidth -
            (hint === "" ? 0 : hint.length + GAP.length) -
            GAP.length,
        );
  return (
    <box
      backgroundColor={PALETTE.surface}
      flexDirection="row"
      flexShrink={0}
      height={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <text wrapMode="word" width={width}>
        <span
          attributes={line.running ? ATTRIBUTES.bold : ATTRIBUTES.none}
          fg={line.running ? PALETTE.accent : PALETTE.dimOnSurface}
        >
          {line.label}
        </span>
        {line.elapsed === "" ? null : <span fg={PALETTE.dimOnSurface}> {line.elapsed}</span>}
        {hint === "" ? null : (
          <span fg={PALETTE.dimOnSurface}>
            {GAP}
            {hint}
          </span>
        )}
        {context === "" ? null : (
          <span fg={PALETTE.dimOnSurface}>
            {GAP}
            {context}
          </span>
        )}
      </text>
      {usage === null ? null : (
        <text fg={PALETTE.dimOnSurface} width={usageWidth}>
          {GAP}
          {usage}
        </text>
      )}
    </box>
  );
}
