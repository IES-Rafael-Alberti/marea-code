/** @jsxImportSource @opentui/react */
import type { BannerCopy } from "../../parity/copy.js";
import type { SessionContext } from "../../parity/events.js";
import { PALETTE } from "../../parity/tokens.js";
import { ATTRIBUTES } from "./theme.js";
import { wordmarkLines, wordmarkLineSpans } from "../../parity/wordmark.js";

/**
 * The opening frame: the wordmark, the context the student is working in, and
 * the two commands worth knowing before anything else.
 */

export interface BannerProperties {
  readonly columns: number;
  readonly context: SessionContext;
  readonly copy: BannerCopy;
}

const LABEL_WIDTH = 13;

export interface ContextLine {
  readonly label: string;
  readonly value: string;
}

/** The context rows, in the reference's order, skipping what is not known. */
export function contextLines(context: SessionContext, copy: BannerCopy): readonly ContextLine[] {
  return [
    { label: copy.model, value: context.model },
    { label: copy.directory, value: context.cwd },
    { label: copy.branch, value: context.branch },
    { label: copy.repository, value: context.repositoryUrl },
  ].filter((line) => line.value !== "");
}

export function Banner({ columns, context, copy }: BannerProperties) {
  const lines = wordmarkLines(columns - 5);
  return (
    <box flexDirection="column" marginBottom={1}>
      {lines.map((line, index) => (
        <text key={`mark-${String(index)}`}>
          {wordmarkLineSpans(line).map((span, spanIndex) => (
            <span
              attributes={ATTRIBUTES.bold}
              fg={span.tone === "mark" ? PALETTE.accent : PALETTE.depth}
              key={`s-${String(spanIndex)}`}
            >
              {span.text}
            </span>
          ))}
        </text>
      ))}
      {contextLines(context, copy).map((line) => (
        <text fg={PALETTE.depth} key={line.label}>
          {line.label.padEnd(LABEL_WIDTH, " ")}
          {line.value}
        </text>
      ))}
      <text> </text>
      <text fg={PALETTE.dim}>{copy.footer}</text>
    </box>
  );
}
