import type { ReactNode } from "react";

/**
 * A safe subset of Markdown for conversation text. It builds React elements, so no HTML in the
 * text is ever interpreted, and links stay readable text rather than executable targets.
 */
export function Markdown({ text }: { readonly text: string }) {
  return <div className="message-text">{blocks(text.split("\n"))}</div>;
}

const LIST = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/u;
const HEADING = /^#{1,6}\s+(.*)$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;

function blocks(lines: readonly string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = String(lines[index]);
    const key = nodes.length;
    if (line.trim() === "") {
      index++;
    } else if (line.trimStart().startsWith("```")) {
      // An unclosed fence runs to the end, so the text stays readable while it streams.
      const end = lines.findIndex((next, at) => at > index && next.trimStart().startsWith("```"));
      const stop = end === -1 ? lines.length : end;
      nodes.push(
        <pre key={key}>
          <code>{lines.slice(index + 1, stop).join("\n")}</code>
        </pre>,
      );
      index = stop + 1;
    } else if (RULE.test(line)) {
      nodes.push(<hr key={key} />);
      index++;
    } else if (HEADING.test(line)) {
      nodes.push(<h4 key={key}>{inline(line.replace(HEADING, "$1"))}</h4>);
      index++;
    } else if (line.startsWith(">")) {
      const quoted = run(lines, index, (next) => next.startsWith(">"));
      nodes.push(
        <blockquote key={key}>
          {blocks(quoted.map((next) => next.replace(/>\s?/u, "")))}
        </blockquote>,
      );
      index += quoted.length;
    } else if (LIST.test(line)) {
      const items = run(lines, index, (next) => LIST.test(next));
      const ordered = /^\s*\d/u.test(line);
      const children = items.map((item, at) => (
        <li key={at}>{inline(item.replace(LIST, "$3"))}</li>
      ));
      nodes.push(
        ordered ? (
          <ol key={key} start={Number(line.replace(LIST, "$2"))}>
            {children}
          </ol>
        ) : (
          <ul key={key}>{children}</ul>
        ),
      );
      index += items.length;
    } else {
      const paragraph = run(lines, index, (next) => next.trim() !== "" && !starts(next));
      nodes.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
      index += paragraph.length;
    }
  }
  return nodes;
}

/** A line that opens a block of its own and so ends a paragraph. */
function starts(line: string): boolean {
  return (
    line.trimStart().startsWith("```") ||
    line.startsWith(">") ||
    LIST.test(line) ||
    HEADING.test(line) ||
    RULE.test(line)
  );
}

/** The consecutive lines from `from` that satisfy `test`; the first always belongs. */
function run(lines: readonly string[], from: number, test: (line: string) => boolean) {
  const end = lines.slice(from + 1).findIndex((line) => !test(line));
  return lines.slice(from, end === -1 ? lines.length : from + 1 + end);
}

// Alternatives are tried in order at each position, so a double mark wins over a single one.
const INLINE =
  /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_(?![\p{L}\p{N}])|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

/** Inline marks; empty text between marks renders nothing. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    nodes.push(text.slice(at, match.index), mark(match, nodes.length));
    at = match.index + match[0].length;
  }
  nodes.push(text.slice(at));
  return nodes;
}

function mark(match: RegExpExecArray, key: number): ReactNode {
  const [, code, bold, underlined, struck, starred, emphasized, label, target] = match;
  if (code !== undefined) return <code key={key}>{code}</code>;
  if (struck !== undefined) return <s key={key}>{inline(struck)}</s>;
  if (label !== undefined) return `${label} (${String(target)})`;
  const strong = bold ?? underlined;
  if (strong !== undefined) return <strong key={key}>{inline(strong)}</strong>;
  return <em key={key}>{inline(starred ?? String(emphasized))}</em>;
}
